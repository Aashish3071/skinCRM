import { recordOptOut } from "../messaging/service";
import { canonicalPersonId } from "../people/service";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { normalizeWhatsAppId } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { ingestSubmission } from "../intake/pipeline";
import { addActivity } from "../leads/service";
import { ensureConversation, touchConversation } from "./store";
import { notifyUsers, usersWith } from "../notifications/service";

const { people, messages, leads, clinics, sourceSubmissions } = schema;

export interface InboundWhatsApp {
  /** The sender's WhatsApp id: their number in international digits. */
  waId: string;
  /** The name on their WhatsApp profile, when the provider sends one. */
  profileName?: string | null;
  body: string;
  providerMessageId: string;
  receivedAt?: Date;
  /** Present when they tapped a click-to-WhatsApp ad (PRD FB-02). */
  referral?: { sourceId?: string | null; sourceType?: string | null; ctwaClid?: string | null } | null;
  attribution?: { accountId?: string | null; campaignId?: string | null; campaignName?: string | null; adsetId?: string | null };
  businessAccountId?: string | null;
}

/**
 * Take in one WhatsApp message from a patient (PRD WA-01, WA-02).
 *
 * The same function will sit behind the real Cloud API webhook in phase 7; the
 * development "simulate" route calls it today. Idempotent on the provider's
 * message id, because webhooks are delivered at least once.
 *
 * An unknown number goes through the normal intake pipeline, so a first
 * message from a stranger becomes a person and a lead exactly like a web form.
 */
export async function receiveInboundWhatsApp(input: InboundWhatsApp): Promise<{ conversationId: string; duplicate: boolean }> {
  const context = getContext();
  const tx = getTx();
  const idempotencyKey = `wa-in:${input.providerMessageId}`;
  const at = input.receivedAt ?? new Date();


  const clinic = (await tx.select({ country: clinics.country }).from(clinics).limit(1))[0];
  const phone = normalizeWhatsAppId(input.waId, clinic?.country ?? "US");
  if (!phone.e164) throw new Error("Inbound WhatsApp message has an unreadable sender id");

  // Serialize intake per number across workers, including different message IDs.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.clinicId}:${phone.e164}`}, 0))`);
  const seen = await tx
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .limit(1);
  if (seen[0]?.conversationId) return { conversationId: seen[0].conversationId, duplicate: true };


  const fromAd = input.referral?.sourceType === "ad" || (!input.referral?.sourceType && Boolean(input.referral?.ctwaClid));
  const attribution = {
    ...(input.attribution ?? {}),
    adId: fromAd ? input.referral?.sourceId ?? null : null,
    referralId: fromAd ? input.referral?.ctwaClid ?? null : null,
  };
  const isOptOut = /^(stop|unsubscribe|cancel|end|quit)[.!\s]*$/i.test(input.body.trim());
  let person = await findByPhone(phone.e164);
  if (!person && isOptOut) {
    const [row] = await tx.insert(people).values({ clinicId: context.clinicId!, displayName: input.profileName?.trim() || phone.e164, phoneRaw: phone.e164, phoneE164: phone.e164, phoneValid: true }).returning({ id: people.id });
    person = row!;
  }
  let leadId: string | null = null;
  let createdLead = false;

  if (!person) {
    const [firstName, ...rest] = (input.profileName ?? "").trim().split(/\s+/);
    const outcome = await ingestSubmission({
      platform: "whatsapp",
      source: fromAd ? "whatsapp_ad" : "whatsapp_organic",
      externalId: `wa-msg:${input.providerMessageId}`,
      attribution,
      submittedAt: at,
      firstName: firstName || null,
      lastName: rest.join(" ") || null,
      phone: phone.e164,
      inquiryNote: input.body.slice(0, 2_000),
      // Writing to the clinic is a clear basis for operational replies on
      // this channel; it is not consent to marketing.
      consent: [{ channel: "whatsapp", purpose: "operational", source: "whatsapp_inbound" }],
      clinicCountry: clinic?.country ?? "US",
    });
    if (outcome.status === "created") { leadId = outcome.leadId; createdLead = true; }
    person = await findByPhone(phone.e164);
    if (!person) throw new Error("Could not match or create the sender");
  }

  if (!leadId) {
    const open = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.personId, person.id), isNull(leads.closedAt), isNull(leads.archivedAt)))
      .orderBy(desc(leads.createdAt))
      .limit(1);
    leadId = open[0]?.id ?? null;
  }

  // Every WhatsApp inquiry is a lead (D-70). A known patient writing in with
  // nothing open — a past client asking about a new treatment — gets a new
  // lead too, so the conversation never lives only in the inbox. A STOP is not
  // an inquiry: it is recorded below and never opens a sales lead.
  if (!leadId && !isOptOut) {
    const outcome = await ingestSubmission({
      platform: "whatsapp",
      source: fromAd ? "whatsapp_ad" : "whatsapp_organic",
      externalId: `wa-msg:${input.providerMessageId}`,
      attribution,
      submittedAt: at,
      phone: phone.e164,
      inquiryNote: input.body.slice(0, 2_000),
      clinicCountry: clinic?.country ?? "US",
    });
    if (outcome.status === "created") { leadId = outcome.leadId; createdLead = true; }
  }

  // Each new ad click is evidence on the open opportunity, without changing its original source.
  if (!createdLead && leadId && fromAd) {
    const inserted = await tx.insert(sourceSubmissions).values({
      clinicId: context.clinicId!, personId: person.id, leadId, platform: "whatsapp", source: "whatsapp_ad",
      externalId: `wa-msg:${input.providerMessageId}`, submittedAt: at, ingestStatus: "processed",
      ...attribution,
      normalizedFields: { businessAccountId: input.businessAccountId ?? null },
    }).onConflictDoNothing().returning({ id: sourceSubmissions.id });
    if (inserted[0]) await addActivity({ personId: person.id, leadId, type: "source_submission", summary: "WhatsApp ad inquiry received", entityType: "source_submission", entityId: inserted[0].id });
  }
  if (createdLead && leadId && input.businessAccountId) {
    await tx.update(sourceSubmissions).set({ normalizedFields: sql`coalesce(${sourceSubmissions.normalizedFields}, '{}'::jsonb) || ${JSON.stringify({ businessAccountId: input.businessAccountId })}::jsonb` }).where(eq(sourceSubmissions.leadId, leadId));
  }

  if (isOptOut) {
    await recordOptOut({ personId: person.id, channel: "whatsapp", destination: phone.e164.replace(/^\+/, ""), detail: "Patient sent an explicit WhatsApp opt-out keyword" });
    await tx.insert(schema.consentRecords).values((["operational", "promotional"] as const).map((purpose) => ({ clinicId: context.clinicId!, personId: person!.id, channel: "whatsapp" as const, purpose, status: "withdrawn" as const, source: "whatsapp_inbound" as const, evidenceReference: input.providerMessageId, occurredAt: at })));
  }
  const conversationId = await ensureConversation(person.id, "whatsapp", leadId);

  await tx.insert(messages).values({
    clinicId: context.clinicId!,
    personId: person.id,
    leadId,
    channel: "whatsapp",
    direction: "inbound",
    classification: "operational",
    recipient: phone.e164.replace(/^\+/, ""),
    renderedBody: input.body,
    state: "delivered",
    providerMessageId: input.providerMessageId,
    idempotencyKey,
    conversationId,
    sentAt: at,
    deliveredAt: at,
  });

  await touchConversation(conversationId, { direction: "inbound", body: input.body, at });

  // One notification per chat, bumped on each new message (D-77).
  const convo = (await tx.select({ assignee: schema.conversations.assignedUserId }).from(schema.conversations).where(eq(schema.conversations.id, conversationId)).limit(1))[0];
  const who = (await tx.select({ name: people.displayName }).from(people).where(eq(people.id, person.id)).limit(1))[0];
  await notifyUsers(convo?.assignee ? [convo.assignee] : await usersWith("conversations:assign"), {
    type: "whatsapp_message",
    title: `WhatsApp from ${who?.name ?? "a patient"}`,
    body: input.body.split("\n")[0]!.slice(0, 80),
    link: `/inbox/${conversationId}`,
    dedupeKey: `wa:${conversationId}`,
  });

  await addActivity({
    personId: person.id,
    leadId,
    type: "whatsapp_received",
    summary: "WhatsApp message received",
    entityType: "conversation",
    entityId: conversationId,
  });

  return { conversationId, duplicate: false };
}

async function findByPhone(e164: string) {
  const rows = await getTx()
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.phoneE164, e164), isNull(people.archivedAt)))
    .limit(1);
  return rows[0] ? { id: await canonicalPersonId(rows[0].id) } : null;
}
