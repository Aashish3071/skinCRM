import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  normalizeEmail,
  normalizePhone,
  type CreatePerson,
  type DuplicateCandidate,
  type DuplicateMatchReason,
  type PersonDto,
  type UpdatePerson,
} from "@skincrm/contracts";
import { schema, type TenantDatabase } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, notFound } from "../errors";
import { diffSummary, recordAudit } from "../audit";

const { people, branches, generalNotes, consentRecords, personMerges, leads, activities, tasks } = schema;

type PersonRow = typeof people.$inferSelect;

/**
 * Build the stored representation of a person's contact details.
 *
 * Normalized values drive matching; the original string is always kept, because
 * a number we failed to parse is still the number the clinic was given (PRD 5).
 */
export function normalizeContactFields(
  input: { phone?: string | null; email?: string | null },
  defaultCountry: string,
) {
  const phone = normalizePhone(input.phone, defaultCountry);
  const email = normalizeEmail(input.email);
  return {
    phoneRaw: input.phone?.trim() || null,
    phoneE164: phone.e164,
    phoneCountry: phone.country,
    phoneValid: phone.valid,
    emailRaw: input.email?.trim() || null,
    emailNormalized: email,
  };
}

/** A person always needs something to show in a list, even with no name given. */
export function buildDisplayName(input: {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
}): string {
  const name = [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(" ").trim();
  if (name) return name;
  // Falling back to a contact detail beats "Unknown" in a list of fifty rows.
  return input.email?.trim() || input.phone?.trim() || "Unnamed contact";
}

/**
 * Find records that may be the same human (PRD ID-06).
 *
 * A normalized phone or email match is `exact` — these are the keys the PRD
 * names, and in a clinic they are reliable. A same-name match is only
 * `possible`, because shared names are common and auto-linking on a name would
 * merge two different patients.
 */
export async function findDuplicateCandidates(params: {
  phoneE164: string | null;
  emailNormalized: string | null;
  firstName?: string | null;
  lastName?: string | null;
  excludePersonId?: string;
}): Promise<DuplicateCandidate[]> {
  const tx = getTx();

  const conditions = [];
  if (params.phoneE164) conditions.push(eq(people.phoneE164, params.phoneE164));
  if (params.emailNormalized) conditions.push(eq(people.emailNormalized, params.emailNormalized));
  if (conditions.length === 0) return [];

  const where = [
    or(...conditions)!,
    // A record already merged away is not a duplicate to offer again.
    isNull(people.mergedIntoPersonId),
    isNull(people.archivedAt),
  ];
  if (params.excludePersonId) where.push(ne(people.id, params.excludePersonId));

  const rows = await tx
    .select()
    .from(people)
    .where(and(...where))
    .limit(10);

  if (rows.length === 0) return [];

  const counts = await leadCountsFor(tx, rows.map((r) => r.id));

  return rows.map((row) => {
    const reasons: DuplicateMatchReason[] = [];
    if (params.phoneE164 && row.phoneE164 === params.phoneE164) reasons.push("phone");
    if (params.emailNormalized && row.emailNormalized === params.emailNormalized) reasons.push("email");
    return {
      person: serializePerson(row),
      reasons,
      confidence: reasons.length > 0 ? ("exact" as const) : ("possible" as const),
      leadCount: counts.get(row.id) ?? 0,
    };
  });
}

async function leadCountsFor(tx: TenantDatabase, personIds: string[]): Promise<Map<string, number>> {
  if (personIds.length === 0) return new Map();
  const rows = await tx
    .select({ personId: leads.personId, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(sql`${leads.personId} in ${personIds}`)
    .groupBy(leads.personId);
  return new Map(rows.map((r) => [r.personId, r.count]));
}

export class DuplicatePersonError extends Error {
  constructor(readonly candidates: DuplicateCandidate[]) {
    super("Someone with these contact details already exists.");
    this.name = "DuplicatePersonError";
  }
}

/**
 * Looser than `CreatePerson` so the inline person on a lead-intake request can
 * be passed straight through. Walk-in intake supplies name and a contact detail
 * and nothing else, and should not have to send nulls for every profile field
 * to satisfy a type.
 */
export type CreatePersonInput = Partial<CreatePerson> &
  Pick<CreatePerson, "allowDuplicate"> & { phone?: string | null; email?: string | null };

export async function createPerson(
  input: CreatePersonInput,
  clinicCountry: string,
): Promise<PersonDto> {
  const context = getContext();
  const tx = getTx();

  const contact = normalizeContactFields(input, clinicCountry);

  if (!input.allowDuplicate) {
    const candidates = await findDuplicateCandidates({
      phoneE164: contact.phoneE164,
      emailNormalized: contact.emailNormalized,
    });
    // Surfaced as a 409 with the candidates, so the UI can offer "use this one"
    // rather than silently creating a second record.
    if (candidates.length > 0) throw new DuplicatePersonError(candidates);
  }

  const inserted = await tx
    .insert(people)
    .values({
      clinicId: context.clinicId!,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      displayName: buildDisplayName(input),
      ...contact,
      preferredContactMethod: input.preferredContactMethod ?? null,
      preferredLanguage: input.preferredLanguage ?? null,
      branchId: input.branchId ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      region: input.region ?? null,
      postalCode: input.postalCode ?? null,
    })
    .returning();

  const person = inserted[0]!;

  await recordAudit({
    action: "record_created",
    entityType: "person",
    entityId: person.id,
    // Field names only. Contact details are redacted by recordAudit.
    changeSummary: { createdWith: Object.keys(input), allowedDuplicate: input.allowDuplicate },
  });

  return serializePerson(person);
}

export async function getPerson(personId: string): Promise<PersonRow> {
  const tx = getTx();
  const rows = await tx.select().from(people).where(eq(people.id, personId)).limit(1);
  const person = rows[0];
  // RLS confines this to the caller's clinic, so a miss is "not found" whether
  // the row is absent or belongs to another tenant.
  if (!person) throw notFound("No such person.");
  return person;
}

export async function updatePerson(
  personId: string,
  input: UpdatePerson,
  clinicCountry: string,
): Promise<PersonDto> {
  const tx = getTx();
  const before = await getPerson(personId);

  const contact = normalizeContactFields(
    {
      phone: input.phone !== undefined ? input.phone : before.phoneRaw,
      email: input.email !== undefined ? input.email : before.emailRaw,
    },
    clinicCountry,
  );
  if (!contact.phoneRaw && !contact.emailRaw) {
    throw badRequest("Keep at least a phone number or an email address.");
  }
  if (input.branchId && input.branchId !== before.branchId) {
    const branch = await tx.select({ id: branches.id }).from(branches)
      .where(and(eq(branches.id, input.branchId), isNull(branches.archivedAt))).limit(1);
    if (!branch[0]) throw badRequest("Choose a branch in this clinic.");
  }

  const firstName = input.firstName !== undefined ? input.firstName : before.firstName;
  const lastName = input.lastName !== undefined ? input.lastName : before.lastName;

  const updates = {
    firstName,
    lastName,
    displayName: buildDisplayName({
      firstName,
      lastName,
      phone: contact.phoneRaw,
      email: contact.emailRaw,
    }),
    ...contact,
    ...(input.preferredContactMethod !== undefined
      ? { preferredContactMethod: input.preferredContactMethod }
      : {}),
    ...(input.preferredLanguage !== undefined ? { preferredLanguage: input.preferredLanguage } : {}),
    ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
    ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
    ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
    ...(input.city !== undefined ? { city: input.city } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
    updatedAt: new Date(),
  };

  const updated = await tx.update(people).set(updates).where(eq(people.id, personId)).returning();

  await recordAudit({
    action: "record_updated",
    entityType: "person",
    entityId: personId,
    changeSummary: diffSummary(before as unknown as Record<string, unknown>, updates),
  });

  return serializePerson(updated[0]!);
}

/**
 * Fold `mergedPersonId` into `survivingPersonId` (PRD ID-06).
 *
 * Everything is re-pointed rather than copied, and the losing record is kept
 * with a pointer to the survivor. A snapshot of exactly what moved is stored so
 * the merge can be reversed (BRD 7: merging must preserve all submissions,
 * notes, tasks, appointments and message history).
 */
export async function mergePeople(params: {
  survivingPersonId: string;
  mergedPersonId: string;
  reason?: string | null;
}): Promise<void> {
  const context = getContext();
  const tx = getTx();

  if (params.survivingPersonId === params.mergedPersonId) {
    throw badRequest("A person cannot be merged into themselves.");
  }

  const surviving = await getPerson(params.survivingPersonId);
  const merged = await getPerson(params.mergedPersonId);

  if (merged.mergedIntoPersonId) {
    throw badRequest("That record has already been merged.");
  }
  if (surviving.mergedIntoPersonId) {
    throw badRequest("The surviving record has itself been merged into another. Merge into that one.");
  }

  // Capture what is about to move, so a revert knows exactly what to put back.
  const [movedLeads, movedNotes, movedTasks, movedConsent, movedActivities] = await Promise.all([
    tx.select({ id: leads.id }).from(leads).where(eq(leads.personId, merged.id)),
    tx.select({ id: generalNotes.id }).from(generalNotes).where(eq(generalNotes.personId, merged.id)),
    tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.personId, merged.id)),
    tx.select({ id: consentRecords.id }).from(consentRecords).where(eq(consentRecords.personId, merged.id)),
    tx.select({ id: activities.id }).from(activities).where(eq(activities.personId, merged.id)),
  ]);

  await tx.update(leads).set({ personId: surviving.id }).where(eq(leads.personId, merged.id));
  await tx.update(generalNotes).set({ personId: surviving.id }).where(eq(generalNotes.personId, merged.id));
  await tx.update(tasks).set({ personId: surviving.id }).where(eq(tasks.personId, merged.id));
  await tx
    .update(consentRecords)
    .set({ personId: surviving.id })
    .where(eq(consentRecords.personId, merged.id));
  await tx.update(activities).set({ personId: surviving.id }).where(eq(activities.personId, merged.id));

  // Fill blanks on the survivor from the record being folded in, so a merge
  // never loses a contact detail the clinic had.
  const filled: Record<string, unknown> = {};
  if (!surviving.phoneE164 && merged.phoneE164) {
    filled.phoneRaw = merged.phoneRaw;
    filled.phoneE164 = merged.phoneE164;
    filled.phoneCountry = merged.phoneCountry;
    filled.phoneValid = merged.phoneValid;
  }
  if (!surviving.emailNormalized && merged.emailNormalized) {
    filled.emailRaw = merged.emailRaw;
    filled.emailNormalized = merged.emailNormalized;
  }
  if (!surviving.firstName && merged.firstName) filled.firstName = merged.firstName;
  if (!surviving.lastName && merged.lastName) filled.lastName = merged.lastName;
  if (!surviving.dateOfBirth && merged.dateOfBirth) filled.dateOfBirth = merged.dateOfBirth;
  if (Object.keys(filled).length > 0) {
    await tx.update(people).set({ ...filled, updatedAt: new Date() }).where(eq(people.id, surviving.id));
  }

  await tx
    .update(people)
    .set({ mergedIntoPersonId: surviving.id, mergedAt: new Date(), updatedAt: new Date() })
    .where(eq(people.id, merged.id));

  await tx.insert(personMerges).values({
    clinicId: context.clinicId!,
    survivingPersonId: surviving.id,
    mergedPersonId: merged.id,
    actorUserId: context.userId,
    snapshot: {
      leadIds: movedLeads.map((r) => r.id),
      noteIds: movedNotes.map((r) => r.id),
      taskIds: movedTasks.map((r) => r.id),
      consentIds: movedConsent.map((r) => r.id),
      activityIds: movedActivities.map((r) => r.id),
      filledFields: Object.keys(filled),
      reason: params.reason ?? null,
    },
  });

  await recordAudit({
    action: "person_merged",
    entityType: "person",
    entityId: surviving.id,
    changeSummary: {
      mergedPersonId: merged.id,
      movedLeads: movedLeads.length,
      movedNotes: movedNotes.length,
      movedTasks: movedTasks.length,
      reason: params.reason ?? null,
    },
  });
}

/** Undo a merge using its snapshot. */
export async function revertMerge(mergeId: string): Promise<void> {
  const tx = getTx();
  const rows = await tx.select().from(personMerges).where(eq(personMerges.id, mergeId)).limit(1);
  const merge = rows[0];
  if (!merge) throw notFound("No such merge.");
  if (merge.revertedAt) throw badRequest("That merge has already been reverted.");

  const snapshot = merge.snapshot as {
    leadIds?: string[];
    noteIds?: string[];
    taskIds?: string[];
    consentIds?: string[];
    activityIds?: string[];
    filledFields?: string[];
  };

  // Move back only the rows this merge actually moved. Anything created since
  // stays with the survivor, which is what a user expects from an undo.
  const restore = async (
    table: typeof leads | typeof generalNotes | typeof tasks | typeof consentRecords | typeof activities,
    ids: string[] | undefined,
  ) => {
    if (!ids || ids.length === 0) return;
    await tx
      .update(table)
      .set({ personId: merge.mergedPersonId })
      .where(sql`${table.id} in ${ids}`);
  };

  await restore(leads, snapshot.leadIds);
  await restore(generalNotes, snapshot.noteIds);
  await restore(tasks, snapshot.taskIds);
  await restore(consentRecords, snapshot.consentIds);
  await restore(activities, snapshot.activityIds);

  await tx
    .update(people)
    .set({ mergedIntoPersonId: null, mergedAt: null, updatedAt: new Date() })
    .where(eq(people.id, merge.mergedPersonId));

  await tx
    .update(personMerges)
    .set({ revertedAt: new Date(), revertedByUserId: getContext().userId })
    .where(eq(personMerges.id, mergeId));

  await recordAudit({
    action: "person_merge_reverted",
    entityType: "person",
    entityId: merge.survivingPersonId,
    changeSummary: { mergeId, restoredPersonId: merge.mergedPersonId },
  });
}

/** Most recent merges, for the review screen and for offering an undo. */
export async function listMerges(limit = 25) {
  const tx = getTx();
  return tx.select().from(personMerges).orderBy(desc(personMerges.mergedAt)).limit(limit);
}

export function serializePerson(row: PersonRow): PersonDto {
  return {
    id: row.id,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phoneRaw,
    phoneE164: row.phoneE164,
    phoneValid: row.phoneValid,
    email: row.emailRaw,
    preferredContactMethod: row.preferredContactMethod,
    preferredLanguage: row.preferredLanguage,
    branchId: row.branchId,
    dateOfBirth: row.dateOfBirth,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    mergedIntoPersonId: row.mergedIntoPersonId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
