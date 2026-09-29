import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  LEAD_SOURCE_LABELS,
  isValidEmail,
  normalizeEmail,
  normalizePhone,
  type ConsentPurpose,
  type ConsentSource,
  type ContactChannel,
  type LeadSource,
  type SourcePlatform,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { encryptForClinic, payloadFingerprint } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { logger } from "../logger";
import { recordAudit } from "../audit";
import { emitAutomationEvent } from "../automations/engine";
import { addActivity, stageByCategory } from "../leads/service";
import { slaDueFor } from "../leads/sla";
import { notifyNewLead } from "../notifications/service";
import { routeLead } from "../leads/assignment";
import { buildDisplayName } from "../people/service";

const {
  people,
  leads,
  sourceSubmissions,
  rawPayloads,
  consentRecords,
  leadStageEvents,
} = schema;

/**
 * The one path every inbound inquiry takes, whatever the channel (PRD 7):
 *
 *   persist submission → deduplicate → match person → create lead → route
 *
 * CSV import and the website endpoint use it today. The Meta, Google and
 * WhatsApp adapters in phase 7 must use it too rather than reimplementing
 * matching and de-duplication, which is where divergence would quietly appear.
 *
 * Deduplication is a unique index on `(clinic_id, platform, external_id)`, not
 * a lookup-then-insert: only the database can make that decision atomically
 * when two deliveries of the same webhook race.
 */

export interface IntakeInput {
  platform: SourcePlatform;
  source: LeadSource;
  /**
   * The provider's own id, or a deterministic one we derive (a CSV row, say).
   * Null only for genuinely one-off internal entries.
   */
  externalId: string | null;
  submittedAt?: Date | null;

  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  serviceInterest?: string | null;
  inquiryNote?: string | null;
  branchId?: string | null;

  attribution?: {
    accountId?: string | null;
    campaignId?: string | null;
    campaignName?: string | null;
    adsetId?: string | null;
    adId?: string | null;
    formId?: string | null;
    formName?: string | null;
    clickId?: string | null;
    referralId?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmTerm?: string | null;
    utmContent?: string | null;
  };

  /** Consent captured at the point of submission, if any. */
  consent?: {
    channel: ContactChannel;
    purpose: ConsentPurpose;
    source: ConsentSource;
    noticeVersion?: string | null;
    capturedText?: string | null;
  }[];

  /** The untouched provider payload. Stored encrypted, separately. */
  rawPayload?: unknown;
  /** Provider flagged this as a test; it must not pollute reporting (INT-03). */
  isTest?: boolean;
  clinicCountry: string;
}

export type IntakeOutcome =
  | { status: "created"; submissionId: string; personId: string; leadId: string; ownerUserId: string | null }
  | { status: "duplicate"; submissionId: string | null; reason: string }
  | { status: "failed"; reason: string };

export async function ingestSubmission(input: IntakeInput): Promise<IntakeOutcome> {
  const context = getContext();
  const tx = getTx();
  const clinicId = context.clinicId!;

  // Forgiving on purpose (D-89): a lead from outside is never dropped over a
  // messy detail. An unreadable phone is kept as written and flagged
  // (phoneValid=false); an email that isn't an address is not stored as one —
  // nothing would ever be sent to it — but kept in the inquiry note.
  const givenEmail = input.email?.trim() || null;
  const emailUsable = isValidEmail(givenEmail);
  if (givenEmail && !emailUsable) {
    input = {
      ...input,
      email: null,
      inquiryNote: [input.inquiryNote?.trim(), `Email given as "${givenEmail.slice(0, 200)}", which isn't a valid address.`].filter(Boolean).join("\n\n"),
    };
  }
  const phone = normalizePhone(input.phone, input.clinicCountry);
  const email = emailUsable ? normalizeEmail(givenEmail) : null;
  const phoneHasDigits = /\d{3,}/.test(input.phone ?? "");

  if (!phone.e164 && !email && !phoneHasDigits) {
    return { status: "failed", reason: givenEmail || input.phone?.trim() ? "No usable phone number or email address" : "No phone or email supplied" };
  }

  // --- 1. Store the raw payload, encrypted and separate ---------------------
  let rawPayloadId: string | null = null;
  if (input.rawPayload !== undefined) {
    const inserted = await tx
      .insert(rawPayloads)
      .values({
        clinicId,
        platform: input.platform,
        encryptedPayload: encryptForClinic(clinicId, JSON.stringify(input.rawPayload)),
        fingerprint: payloadFingerprint(input.rawPayload),
      })
      .returning({ id: rawPayloads.id });
    rawPayloadId = inserted[0]!.id;
  }

  // --- 2. Persist the submission, letting the unique index deduplicate ------
  const submissionValues = {
    clinicId,
    platform: input.platform,
    externalId: input.externalId,
    source: input.source,
    submittedAt: input.submittedAt ?? null,
    isTest: input.isTest ?? false,
    rawPayloadId,
    payloadFingerprint: input.rawPayload !== undefined ? payloadFingerprint(input.rawPayload) : null,
    correlationId: context.correlationId,
    // Mapped, non-sensitive detail only; contact values live on the person.
    normalizedFields: {
      hasPhone: Boolean(phone.e164 ?? input.phone),
      hasEmail: Boolean(email),
      serviceInterest: input.serviceInterest ?? null,
    } as Record<string, unknown>,
    ...(input.attribution ?? {}),
    ingestStatus: "processing" as const,
  };

  const insertedSubmission = await tx
    .insert(sourceSubmissions)
    .values(submissionValues)
    .onConflictDoNothing({
      target: [sourceSubmissions.clinicId, sourceSubmissions.platform, sourceSubmissions.externalId],
      /**
       * The unique index is partial (`where external_id is not null`), and
       * Postgres will not use a partial index for conflict inference unless the
       * same predicate appears here. Without it every insert fails with "no
       * unique or exclusion constraint matching the ON CONFLICT specification"
       * instead of deduplicating.
       *
       * Note the option is `where`, not `targetWhere`: on `onConflictDoNothing`
       * Drizzle calls the index predicate `where`, and an unknown extra key is
       * silently ignored rather than rejected.
       */
      where: sql`${sourceSubmissions.externalId} is not null`,
    })
    .returning({ id: sourceSubmissions.id });

  if (insertedSubmission.length === 0) {
    // The unique index rejected it: this exact delivery has been seen before.
    // Idempotent by construction — no second lead, no second acknowledgement.
    const existing = await tx
      .select({ id: sourceSubmissions.id })
      .from(sourceSubmissions)
      .where(
        and(
          eq(sourceSubmissions.platform, input.platform),
          eq(sourceSubmissions.externalId, input.externalId!),
        ),
      )
      .limit(1);
    logger.info(
      { platform: input.platform, correlationId: context.correlationId },
      "Duplicate submission ignored",
    );
    return {
      status: "duplicate",
      submissionId: existing[0]?.id ?? null,
      reason: "A submission with this external id already exists",
    };
  }

  const submissionId = insertedSubmission[0]!.id;

  // --- 3. Match or create the person ---------------------------------------
  const matched = await matchPerson(phone.e164, email);
  let personId: string;

  if (matched) {
    personId = matched;
    // Fill in anything the existing record was missing, without overwriting.
    await backfillPerson(personId, { phone, email, input });
  } else {
    const created = await tx
      .insert(people)
      .values({
        clinicId,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        displayName: buildDisplayName({
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          email: input.email,
        }),
        phoneRaw: input.phone?.trim() || null,
        phoneE164: phone.e164,
        phoneCountry: phone.country,
        phoneValid: phone.valid,
        emailRaw: input.email?.trim() || null,
        emailNormalized: email,
        branchId: input.branchId ?? null,
      })
      .returning({ id: people.id });
    personId = created[0]!.id;
  }

  // --- 4. Consent captured at submission -----------------------------------
  for (const consent of input.consent ?? []) {
    await tx.insert(consentRecords).values({
      clinicId,
      personId,
      channel: consent.channel,
      purpose: consent.purpose,
      status: "granted",
      source: consent.source,
      noticeVersion: consent.noticeVersion ?? null,
      capturedText: consent.capturedText ?? null,
      // Ties the consent back to the exact submission that captured it.
      evidenceReference: `source_submission:${submissionId}`,
    });
  }

  // --- 5. Open a lead and route it -----------------------------------------
  const newStage = await stageByCategory("new");
  const routing = await routeLead({
    source: input.source,
    serviceInterest: input.serviceInterest ?? null,
    branchId: input.branchId ?? null,
  });

  const insertedLead = await tx
    .insert(leads)
    .values({
      clinicId,
      personId,
      sourceSubmissionId: submissionId,
      source: input.source,
      stageId: newStage.id,
      ownerUserId: routing.ownerUserId,
      branchId: input.branchId ?? null,
      serviceInterest: input.serviceInterest ?? null,
      inquiryNote: input.inquiryNote ?? null,
      isTest: input.isTest ?? false,
      slaDueAt: await slaDueFor(new Date()),
    })
    .returning({ id: leads.id });

  const leadId = insertedLead[0]!.id;

  await tx.insert(leadStageEvents).values({
    clinicId,
    leadId,
    fromStageId: null,
    toStageId: newStage.id,
    actorUserId: context.userId,
    reason: null,
  });

  await tx
    .update(sourceSubmissions)
    .set({ ingestStatus: "processed", personId, leadId, updatedAt: new Date() })
    .where(eq(sourceSubmissions.id, submissionId));

  await addActivity({
    personId,
    leadId,
    type: "source_submission",
    summary: `Inquiry received from ${input.source.replace(/_/g, " ")}`,
    body: input.inquiryNote ?? null,
    entityType: "source_submission",
    entityId: submissionId,
    metadata: {
      platform: input.platform,
      matchedExistingPerson: matched !== null,
      ...(routing.ruleName ? { assignedByRule: routing.ruleName } : {}),
    },
  });

  await recordAudit({
    action: "record_created",
    entityType: "lead",
    entityId: leadId,
    changeSummary: {
      via: "intake",
      platform: input.platform,
      source: input.source,
      matchedExistingPerson: matched !== null,
      assigned: routing.ownerUserId !== null,
    },
  });

  await emitAutomationEvent({ type: "lead_created", leadId, personId, source: input.source });
  const personRow = (await tx.select({ name: people.displayName }).from(people).where(eq(people.id, personId)).limit(1))[0];
  await notifyNewLead({ id: leadId, ownerUserId: routing.ownerUserId }, personRow?.name ?? "Someone", LEAD_SOURCE_LABELS[input.source]);

  return { status: "created", submissionId, personId, leadId, ownerUserId: routing.ownerUserId };
}

/**
 * Link to an existing person on an exact normalized phone or email (PRD ID-06).
 *
 * Automatic linking is deliberately limited to those two keys. A name match is
 * not enough to merge two humans without a person looking at it, and getting
 * this wrong means one patient seeing another's history.
 */
async function matchPerson(phoneE164: string | null, email: string | null): Promise<string | null> {
  if (!phoneE164 && !email) return null;
  const tx = getTx();

  const conditions = [];
  if (phoneE164) conditions.push(eq(people.phoneE164, phoneE164));
  if (email) conditions.push(eq(people.emailNormalized, email));

  const rows = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(or(...conditions)!, isNull(people.mergedIntoPersonId), isNull(people.archivedAt)))
    .limit(2);

  // Exactly one match links automatically. Two different people sharing a phone
  // or email is ambiguous, so the submission opens a new record and the pair
  // surfaces in the duplicate review queue instead of guessing.
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Add contact details the existing record lacked. Never overwrites. */
async function backfillPerson(
  personId: string,
  args: {
    phone: ReturnType<typeof normalizePhone>;
    email: string | null;
    input: IntakeInput;
  },
): Promise<void> {
  const tx = getTx();
  const rows = await tx.select().from(people).where(eq(people.id, personId)).limit(1);
  const person = rows[0];
  if (!person) return;

  const updates: Record<string, unknown> = {};
  if (!person.phoneE164 && args.phone.e164) {
    updates.phoneRaw = args.input.phone?.trim() ?? null;
    updates.phoneE164 = args.phone.e164;
    updates.phoneCountry = args.phone.country;
    updates.phoneValid = args.phone.valid;
  }
  if (!person.emailNormalized && args.email) {
    updates.emailRaw = args.input.email?.trim() ?? null;
    updates.emailNormalized = args.email;
  }
  if (!person.firstName && args.input.firstName) updates.firstName = args.input.firstName;
  if (!person.lastName && args.input.lastName) updates.lastName = args.input.lastName;

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date();
    await tx.update(people).set(updates).where(eq(people.id, personId));
  }
}
