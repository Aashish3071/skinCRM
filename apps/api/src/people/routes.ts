import type { FastifyInstance } from "fastify";
import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createNoteSchema,
  createPersonSchema,
  listPeopleQuerySchema,
  mergePeopleSchema,
  recordConsentSchema,
  updateNoteSchema,
  updatePersonSchema,
  uuidSchema,
  type ConsentState,
  type NoteDto,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { AppError, notFound } from "../errors";
import { recordAudit, recordSensitiveAccess } from "../audit";
import { registerRoute } from "../route";
import { maskPeopleFields, maskPersonFields } from "../serialize";
import {
  DuplicatePersonError,
  createPerson,
  findDuplicateCandidates,
  getPerson,
  listMerges,
  mergePeople,
  revertMerge,
  serializePerson,
  updatePerson,
} from "./service";

const { people, generalNotes, consentRecords, leads, clinics } = schema;

export function registerPeopleRoutes(app: FastifyInstance): void {
  // --- List and search ----------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/people",
    auth: { capability: "people:read" },
    query: listPeopleQuerySchema,
    handler: async ({ query }) => {
      const tx = getTx();

      const conditions = [isNull(people.archivedAt)];
      if (!query.includeMerged) conditions.push(isNull(people.mergedIntoPersonId));

      if (query.search) {
        const pattern = `%${query.search}%`;
        // Match what staff actually type: a name fragment, or part of a phone or
        // email. Digits-only is stripped so "305 555" finds "+13055550123".
        const digits = query.search.replace(/\D+/g, "");
        const searchConditions = [
          ilike(people.displayName, pattern),
          ilike(people.emailRaw, pattern),
          ilike(people.phoneRaw, pattern),
        ];
        if (digits.length >= 3) {
          searchConditions.push(sql`${people.phoneE164} like ${"%" + digits + "%"}`);
        }
        conditions.push(or(...searchConditions)!);
      }

      if (query.branchId) conditions.push(eq(people.branchId, query.branchId));

      const rows = await tx
        .select()
        .from(people)
        .where(and(...conditions))
        .orderBy(desc(people.updatedAt))
        .limit(query.limit)
        .offset(query.offset);

      const totals = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(people)
        .where(and(...conditions));

      return {
        items: maskPeopleFields(rows.map(serializePerson)),
        totalCount: totals[0]?.total ?? 0,
        nextCursor: null,
      };
    },
  });

  // --- Create -------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/people",
    auth: { capability: "people:write" },
    body: createPersonSchema,
    status: 201,
    handler: async ({ body }) => {
      const country = await clinicCountry();
      try {
        return maskPersonFields(await createPerson(body, country));
      } catch (error) {
        if (error instanceof DuplicatePersonError) {
          throw duplicateConflict(
            error.candidates.map((c) => ({ ...c, person: maskPersonFields(c.person) })),
          );
        }
        throw error;
      }
    },
  });

  // --- Duplicate check without creating ----------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/people/check-duplicates",
    auth: { capability: "people:read" },
    body: z.object({
      phone: z.string().max(40).optional(),
      email: z.string().max(320).optional(),
      excludePersonId: uuidSchema.optional(),
    }),
    status: 200,
    handler: async ({ body }) => {
      const country = await clinicCountry();
      const { normalizeContactFields } = await import("./service");
      const contact = normalizeContactFields(body, country);
      const candidates = await findDuplicateCandidates({
        phoneE164: contact.phoneE164,
        emailNormalized: contact.emailNormalized,
        ...(body.excludePersonId ? { excludePersonId: body.excludePersonId } : {}),
      });
      return {
        candidates: candidates.map((c) => ({ ...c, person: maskPersonFields(c.person) })),
      };
    },
  });

  // --- Read one -----------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/people/:id",
    auth: { capability: "people:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const person = await getPerson(params.id);
      // Opening a person record is sensitive access in its own right (AUD-01).
      await recordSensitiveAccess("person", person.id);
      return maskPersonFields(serializePerson(person));
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/people/:id",
    auth: { capability: "people:write" },
    params: z.object({ id: uuidSchema }),
    body: updatePersonSchema,
    handler: async ({ params, body }) =>
      maskPersonFields(await updatePerson(params.id, body, await clinicCountry())),
  });

  // --- General Notes (PRD ID-08) -----------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/people/:id/notes",
    auth: { capability: "notes:read" },
    params: z.object({ id: uuidSchema }),
    query: z.object({ includeArchived: z.coerce.boolean().default(false) }),
    handler: async ({ params, query }) => {
      const tx = getTx();
      await getPerson(params.id);

      const conditions = [eq(generalNotes.personId, params.id)];
      if (!query.includeArchived) conditions.push(isNull(generalNotes.archivedAt));

      const rows = await tx
        .select()
        .from(generalNotes)
        .where(and(...conditions))
        // Pinned first, then newest: what staff must remember, then what is new.
        .orderBy(desc(generalNotes.pinned), desc(generalNotes.createdAt));

      return { items: rows.map(serializeNote) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/people/:id/notes",
    auth: { capability: "notes:write" },
    params: z.object({ id: uuidSchema }),
    body: createNoteSchema,
    status: 201,
    handler: async ({ params, body }) => {
      const context = getContext();
      const tx = getTx();
      const person = await getPerson(params.id);

      const inserted = await tx
        .insert(generalNotes)
        .values({
          clinicId: context.clinicId!,
          personId: person.id,
          body: body.body,
          pinned: body.pinned,
          authorUserId: context.userId,
          authorLabel: await actorLabel(),
        })
        .returning();

      await recordAudit({
        action: "record_created",
        entityType: "general_note",
        entityId: inserted[0]!.id,
        // Length only. The note body itself never enters the audit trail or a
        // log line, because it can hold sensitive context (PRD 8).
        changeSummary: { personId: person.id, pinned: body.pinned, bodyLength: body.body.length },
      });

      return serializeNote(inserted[0]!);
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/notes/:noteId",
    auth: { capability: "notes:write" },
    params: z.object({ noteId: uuidSchema }),
    body: updateNoteSchema,
    handler: async ({ params, body }) => {
      const context = getContext();
      const tx = getTx();
      const existing = await loadNote(params.noteId);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.body !== undefined) {
        updates.body = body.body;
        updates.editedAt = new Date();
        updates.editedByUserId = context.userId;
      }
      if (body.pinned !== undefined) updates.pinned = body.pinned;

      const updated = await tx
        .update(generalNotes)
        .set(updates)
        .where(eq(generalNotes.id, existing.id))
        .returning();

      await recordAudit({
        action: "note_edited",
        entityType: "general_note",
        entityId: existing.id,
        changeSummary: {
          personId: existing.personId,
          bodyChanged: body.body !== undefined,
          pinnedChanged: body.pinned !== undefined,
        },
      });

      return serializeNote(updated[0]!);
    },
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/notes/:noteId",
    auth: { capability: "notes:archive" },
    params: z.object({ noteId: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      const tx = getTx();
      const existing = await loadNote(params.noteId);
      // Archived, never deleted: the note is part of the record's history.
      await tx
        .update(generalNotes)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(generalNotes.id, existing.id));
      await recordAudit({
        action: "note_archived",
        entityType: "general_note",
        entityId: existing.id,
        changeSummary: { personId: existing.personId },
      });
      return null;
    },
  });

  // --- Consent (PRD MSG-04) ----------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/people/:id/consent",
    auth: { capability: "consent:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const tx = getTx();
      await getPerson(params.id);

      const history = await tx
        .select()
        .from(consentRecords)
        .where(eq(consentRecords.personId, params.id))
        .orderBy(desc(consentRecords.occurredAt));

      // Current state is the newest row per (channel, purpose). Computed here
      // rather than stored, so the ledger stays append-only.
      const current = new Map<string, ConsentState>();
      for (const row of history) {
        const key = `${row.channel}:${row.purpose}`;
        if (!current.has(key)) {
          current.set(key, {
            channel: row.channel,
            purpose: row.purpose,
            status: row.status,
            source: row.source,
            noticeVersion: row.noticeVersion,
            occurredAt: row.occurredAt.toISOString(),
            recordedByUserId: row.recordedByUserId,
          });
        }
      }

      return {
        current: [...current.values()],
        history: history.map((row) => ({
          id: row.id,
          channel: row.channel,
          purpose: row.purpose,
          status: row.status,
          source: row.source,
          noticeVersion: row.noticeVersion,
          occurredAt: row.occurredAt.toISOString(),
          recordedByUserId: row.recordedByUserId,
        })),
      };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/people/:id/consent",
    auth: { capability: "consent:write" },
    params: z.object({ id: uuidSchema }),
    body: recordConsentSchema,
    status: 201,
    handler: async ({ params, body }) => {
      const context = getContext();
      const tx = getTx();
      const person = await getPerson(params.id);

      const inserted = await tx
        .insert(consentRecords)
        .values({
          clinicId: context.clinicId!,
          personId: person.id,
          channel: body.channel,
          purpose: body.purpose,
          status: body.status,
          source: body.source,
          noticeVersion: body.noticeVersion ?? null,
          evidenceReference: body.evidenceReference ?? null,
          capturedText: body.capturedText ?? null,
          recordedByUserId: context.userId,
        })
        .returning();

      await recordAudit({
        action: "consent_changed",
        entityType: "person",
        entityId: person.id,
        changeSummary: {
          channel: body.channel,
          purpose: body.purpose,
          status: body.status,
          source: body.source,
        },
      });

      return { id: inserted[0]!.id };
    },
  });

  // --- Duplicate review and merge ----------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/people/duplicates",
    auth: { capability: "people:merge" },
    handler: async () => {
      const tx = getTx();

      // Groups of live records sharing a normalized phone or email. This is the
      // review queue; nothing is merged without a person deciding.
      const groups = await tx
        .select({
          phoneE164: people.phoneE164,
          emailNormalized: people.emailNormalized,
          ids: sql<string[]>`array_agg(${people.id}::text)`,
          count: sql<number>`count(*)::int`,
        })
        .from(people)
        .where(
          and(
            isNull(people.mergedIntoPersonId),
            isNull(people.archivedAt),
            or(isNotNull(people.phoneE164), isNotNull(people.emailNormalized))!,
          ),
        )
        .groupBy(people.phoneE164, people.emailNormalized)
        .having(sql`count(*) > 1`)
        .limit(50);

      const allIds = groups.flatMap((g) => g.ids);
      if (allIds.length === 0) return { items: [] };

      const rows = await tx.select().from(people).where(sql`${people.id} in ${allIds}`);
      const byId = new Map(rows.map((r) => [r.id, r]));

      return {
        items: groups.map((group) => ({
          matchedOn: group.phoneE164 ? "phone" : "email",
          people: maskPeopleFields(
            group.ids.map((id) => byId.get(id)).filter(Boolean).map((r) => serializePerson(r!)),
          ),
        })),
      };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/people/:id/merge",
    auth: { capability: "people:merge" },
    params: z.object({ id: uuidSchema }),
    body: mergePeopleSchema,
    status: 200,
    handler: async ({ params, body }) => {
      await mergePeople({
        survivingPersonId: params.id,
        mergedPersonId: body.mergedPersonId,
        reason: body.reason ?? null,
      });
      return maskPersonFields(serializePerson(await getPerson(params.id)));
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/people/merges",
    auth: { capability: "people:merge" },
    handler: async () => ({
      items: (await listMerges()).map((m) => ({
        id: m.id,
        survivingPersonId: m.survivingPersonId,
        mergedPersonId: m.mergedPersonId,
        mergedAt: m.mergedAt.toISOString(),
        revertedAt: m.revertedAt?.toISOString() ?? null,
      })),
    }),
  });

  registerRoute(app, {
    method: "POST",
    url: "/people/merges/:mergeId/revert",
    auth: { capability: "people:merge" },
    params: z.object({ mergeId: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      await revertMerge(params.mergeId);
      return null;
    },
  });

  // --- A person's inquiries ----------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/people/:id/leads",
    auth: { capability: "leads:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const tx = getTx();
      await getPerson(params.id);
      const rows = await tx
        .select()
        .from(leads)
        .where(eq(leads.personId, params.id))
        .orderBy(desc(leads.createdAt));
      return {
        items: rows.map((row) => ({
          id: row.id,
          source: row.source,
          stageId: row.stageId,
          ownerUserId: row.ownerUserId,
          serviceInterest: row.serviceInterest,
          createdAt: row.createdAt.toISOString(),
          closedAt: row.closedAt?.toISOString() ?? null,
        })),
      };
    },
  });
}

/**
 * 409 carrying the duplicate candidates alongside the error envelope, so the UI
 * can offer "use this record" rather than leaving the user to search again.
 */
function duplicateConflict(candidates: unknown[]): AppError {
  return new AppError(
    409,
    "duplicate_person",
    "Someone with these contact details already exists. Use the existing record, or create a new one deliberately.",
    undefined,
    { candidates },
  );
}

async function loadNote(noteId: string) {
  const tx = getTx();
  const rows = await tx.select().from(generalNotes).where(eq(generalNotes.id, noteId)).limit(1);
  const note = rows[0];
  if (!note) throw notFound("No such note.");
  return note;
}

function serializeNote(row: typeof generalNotes.$inferSelect): NoteDto {
  return {
    id: row.id,
    personId: row.personId,
    body: row.body,
    pinned: row.pinned,
    authorLabel: row.authorLabel,
    authorUserId: row.authorUserId,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

async function clinicCountry(): Promise<string> {
  const tx = getTx();
  const rows = await tx.select({ country: clinics.country }).from(clinics).limit(1);
  return rows[0]?.country ?? "US";
}

async function actorLabel(): Promise<string | null> {
  const tx = getTx();
  const context = getContext();
  if (!context.userId) return null;
  const rows = await tx
    .select({ fullName: schema.users.fullName })
    .from(schema.users)
    .where(eq(schema.users.id, context.userId))
    .limit(1);
  return rows[0]?.fullName ?? null;
}
