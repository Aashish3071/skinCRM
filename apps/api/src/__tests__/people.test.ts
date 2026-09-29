/**
 * People, General Notes, consent and merge (PRD ID-02, ID-06, ID-08, MSG-04).
 *
 * Requires a migrated and seeded database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";

const { people, generalNotes, consentRecords, personMerges, auditEvents, activities } = schema;

let app: FastifyInstance;
let adminCookie: string;

/** Everything this suite creates is tagged so cleanup cannot miss a row. */
const TAG = "peopletest";

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  adminCookie = await authenticate(app, SEED.admin);
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeAllConnections();
});

beforeEach(async () => {
  await cleanup();
});

async function cleanup(): Promise<void> {
  const { db } = getOwnerDb();
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(or(like(people.emailRaw, `%${TAG}%`), like(people.displayName, `%${TAG}%`)));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(personMerges).where(inArray(personMerges.mergedPersonId, ids));
  await db.delete(personMerges).where(inArray(personMerges.survivingPersonId, ids));
  await db.delete(generalNotes).where(inArray(generalNotes.personId, ids));
  await db.delete(consentRecords).where(inArray(consentRecords.personId, ids));
  await db.delete(people).where(inArray(people.id, ids));
}

async function createPerson(
  payload: Record<string, unknown>,
  cookie = adminCookie,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({ method: "POST", url: "/people", headers: { cookie }, payload });
  return { status: response.statusCode, body: response.json() };
}

describe("creating a person", () => {
  it("normalizes the phone to E.164 and keeps the original", async () => {
    const { status, body } = await createPerson({
      firstName: "Rosa",
      lastName: `Delgado ${TAG}`,
      // How a receptionist actually types a Florida number.
      phone: "(305) 555-0123",
      email: `rosa.${TAG}@example.test`,
    });

    expect(status).toBe(201);
    expect(body.phoneE164).toBe("+13055550123");
    expect(body.phoneValid).toBe(true);
    // The original is preserved for audit (PRD 5).
    expect(body.phone).toBe("(305) 555-0123");
  });

  it("refuses a phone that isn't a number when staff type it (D-89)", async () => {
    // Imports and web forms keep unreadable numbers instead (validation.test.ts);
    // someone at the desk can simply correct it.
    const { status, body } = await createPerson({
      firstName: `Nate ${TAG}`,
      phone: "ask for the mobile",
      email: `nate.${TAG}@example.test`,
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/only contain digits/);
  });

  it("requires at least a phone or an email", async () => {
    const { status, body } = await createPerson({ firstName: `Nobody ${TAG}` });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/phone number or an email/i);
  });

  it("builds a display name from a contact detail when no name is given", async () => {
    const { body } = await createPerson({ email: `anon.${TAG}@example.test` });
    expect(body.displayName).toBe(`anon.${TAG}@example.test`);
  });

  it("lower-cases the email for matching but keeps what was typed", async () => {
    const { body } = await createPerson({
      firstName: `Case ${TAG}`,
      email: `MiXeD.${TAG}@Example.TEST`,
    });
    expect(body.email).toBe(`MiXeD.${TAG}@Example.TEST`);

    // A differently-cased duplicate must still be detected.
    const second = await createPerson({
      firstName: `Case Two ${TAG}`,
      email: `mixed.${TAG}@example.test`,
    });
    expect(second.status).toBe(409);
  });
});

describe("editing a patient", () => {
  it("updates contact and city, and refuses to remove the last contact method", async () => {
    const { body: created } = await createPerson({
      firstName: `Edit ${TAG}`,
      phone: "305-555-0399",
    });
    const id = created.id as string;
    const updated = await app.inject({
      method: "PATCH", url: `/people/${id}`, headers: { cookie: adminCookie },
      payload: { phone: null, email: `edit.${TAG}@example.test`, city: "Tampa" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ phone: null, email: `edit.${TAG}@example.test`, city: "Tampa" });

    const invalid = await app.inject({
      method: "PATCH", url: `/people/${id}`, headers: { cookie: adminCookie },
      payload: { email: null },
    });
    expect(invalid.statusCode).toBe(400);
    const readBack = await app.inject({ method: "GET", url: `/people/${id}`, headers: { cookie: adminCookie } });
    expect(readBack.json().email).toBe(`edit.${TAG}@example.test`);
  });
});

describe("duplicate detection (PRD ID-06)", () => {
  it("refuses a second person with the same phone and returns the candidates", async () => {
    await createPerson({ firstName: `Ana ${TAG}`, phone: "305-555-0199" });

    const { status, body } = await createPerson({
      firstName: `Ana Maria ${TAG}`,
      // Same number, written differently.
      phone: "+1 (305) 555 0199",
    });

    expect(status).toBe(409);
    expect((body.error as { code: string }).code).toBe("duplicate_person");

    const candidates = body.candidates as { reasons: string[]; confidence: string }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.reasons).toContain("phone");
    expect(candidates[0]!.confidence).toBe("exact");
  });

  it("creates anyway when the user deliberately opts in", async () => {
    await createPerson({ firstName: `Twin ${TAG}`, phone: "305-555-0200" });
    const { status } = await createPerson({
      firstName: `Twin Two ${TAG}`,
      phone: "305-555-0200",
      allowDuplicate: true,
    });
    expect(status).toBe(201);
  });

  it("does not treat two different people as duplicates", async () => {
    await createPerson({ firstName: `A ${TAG}`, phone: "305-555-0301" });
    const { status } = await createPerson({ firstName: `B ${TAG}`, phone: "305-555-0302" });
    expect(status).toBe(201);
  });

  it("can check for duplicates without creating anything", async () => {
    await createPerson({ firstName: `Probe ${TAG}`, email: `probe.${TAG}@example.test` });

    const response = await app.inject({
      method: "POST",
      url: "/people/check-duplicates",
      headers: { cookie: adminCookie },
      payload: { email: `probe.${TAG}@example.test` },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json().candidates as unknown[]).length).toBe(1);
  });

  it("surfaces a duplicate group in the review queue", async () => {
    await createPerson({ firstName: `Dup A ${TAG}`, phone: "305-555-0400" });
    await createPerson({ firstName: `Dup B ${TAG}`, phone: "305-555-0400", allowDuplicate: true });

    const response = await app.inject({
      method: "GET",
      url: "/people/duplicates",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const groups = response.json().items as { people: { displayName: string }[] }[];
    const ours = groups.find((g) => g.people.some((p) => p.displayName.includes(TAG)));
    expect(ours).toBeDefined();
    expect(ours!.people.length).toBe(2);
  });
});

describe("General Notes (PRD ID-08)", () => {
  it("filters Notes and Activity by whole days in the clinic timezone", async () => {
    const { body: person } = await createPerson({ firstName: `Dates ${TAG}`, email: `dates.${TAG}@example.test` });
    const personId = person.id as string;
    const createNote = (body: string) => app.inject({
      method: "POST", url: `/people/${personId}/notes`, headers: { cookie: adminCookie }, payload: { body },
    });
    const before = await createNote("Before the clinic day");
    const during = await createNote("During the clinic day");
    const { db } = getOwnerDb();
    await db.update(generalNotes).set({ createdAt: new Date("2026-03-08T04:30:00Z") })
      .where(eq(generalNotes.id, before.json().id));
    await db.update(generalNotes).set({ createdAt: new Date("2026-03-08T05:30:00Z") })
      .where(eq(generalNotes.id, during.json().id));
    const [record] = await db.select({ clinicId: people.clinicId }).from(people).where(eq(people.id, personId));
    await db.insert(activities).values([
      { clinicId: record!.clinicId, personId, type: "note", summary: "Before", occurredAt: new Date("2026-03-08T04:30:00Z") },
      { clinicId: record!.clinicId, personId, type: "note", summary: "During", occurredAt: new Date("2026-03-08T05:30:00Z") },
    ]);

    const range = "from=2026-03-08&to=2026-03-08";
    const notes = await app.inject({ method: "GET", url: `/notes?personId=${personId}&${range}`, headers: { cookie: adminCookie } });
    expect(notes.statusCode).toBe(200);
    expect((notes.json().items as { body: string }[]).map((item) => item.body)).toEqual(["During the clinic day"]);
    const activity = await app.inject({ method: "GET", url: `/activities?personId=${personId}&${range}`, headers: { cookie: adminCookie } });
    expect(activity.statusCode).toBe(200);
    expect((activity.json().items as { summary: string }[]).map((item) => item.summary)).toEqual(["During"]);
  });

  it("belongs to the person and is visible from any of their inquiries", async () => {
    const { body: person } = await createPerson({
      firstName: `Noted ${TAG}`,
      phone: "305-555-0500",
    });
    const personId = person.id as string;

    const created = await app.inject({
      method: "POST",
      url: `/people/${personId}/notes`,
      headers: { cookie: adminCookie },
      payload: { body: "Prefers evening appointments. Speaks Portuguese.", pinned: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().pinned).toBe(true);
    expect(created.json().authorLabel).toBe("Dana Okafor");

    const listed = await app.inject({
      method: "GET",
      url: `/people/${personId}/notes`,
      headers: { cookie: adminCookie },
    });
    const items = listed.json().items as { body: string; pinned: boolean }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toContain("Portuguese");
  });

  it("sorts pinned notes first, then newest", async () => {
    const { body: person } = await createPerson({ firstName: `Sort ${TAG}`, phone: "305-555-0501" });
    const personId = person.id as string;

    const add = (text: string, pinned: boolean) =>
      app.inject({
        method: "POST",
        url: `/people/${personId}/notes`,
        headers: { cookie: adminCookie },
        payload: { body: text, pinned },
      });

    await add("oldest unpinned", false);
    await add("pinned one", true);
    await add("newest unpinned", false);

    const listed = await app.inject({
      method: "GET",
      url: `/people/${personId}/notes`,
      headers: { cookie: adminCookie },
    });
    const bodies = (listed.json().items as { body: string }[]).map((n) => n.body);
    expect(bodies[0]).toBe("pinned one");
    expect(bodies[1]).toBe("newest unpinned");
  });

  it("archives rather than deletes, and hides archived notes by default", async () => {
    const { body: person } = await createPerson({ firstName: `Arch ${TAG}`, phone: "305-555-0502" });
    const personId = person.id as string;

    const created = await app.inject({
      method: "POST",
      url: `/people/${personId}/notes`,
      headers: { cookie: adminCookie },
      payload: { body: "temporary note" },
    });
    const noteId = created.json().id as string;

    const archived = await app.inject({
      method: "DELETE",
      url: `/notes/${noteId}`,
      headers: { cookie: adminCookie },
    });
    expect(archived.statusCode).toBe(204);

    const defaultList = await app.inject({
      method: "GET",
      url: `/people/${personId}/notes`,
      headers: { cookie: adminCookie },
    });
    expect(defaultList.json().items).toHaveLength(0);

    // The row still exists and can be shown deliberately.
    const withArchived = await app.inject({
      method: "GET",
      url: `/people/${personId}/notes?includeArchived=true`,
      headers: { cookie: adminCookie },
    });
    expect(withArchived.json().items).toHaveLength(1);

    const { db } = getOwnerDb();
    const stillThere = await db.select().from(generalNotes).where(eq(generalNotes.id, noteId));
    expect(stillThere).toHaveLength(1);
  });

  it("records an edit with an audit entry that does not contain the note text", async () => {
    const { body: person } = await createPerson({ firstName: `Edit ${TAG}`, phone: "305-555-0503" });
    const personId = person.id as string;

    const created = await app.inject({
      method: "POST",
      url: `/people/${personId}/notes`,
      headers: { cookie: adminCookie },
      payload: { body: "original text about the client" },
    });
    const noteId = created.json().id as string;

    const secret = "SENSITIVE-DETAIL-THAT-MUST-NOT-BE-AUDITED";
    const edited = await app.inject({
      method: "PATCH",
      url: `/notes/${noteId}`,
      headers: { cookie: adminCookie },
      payload: { body: secret },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().editedAt).not.toBeNull();

    // PRD 8: General Notes must stay out of logs and provider payloads. The
    // audit trail is not an exception.
    const { db } = getOwnerDb();
    const entries = await db
      .select({ summary: auditEvents.changeSummary })
      .from(auditEvents)
      .where(eq(auditEvents.action, "note_edited"));
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it("does not leak notes across tenants", async () => {
    const { body: person } = await createPerson({ firstName: `Cross ${TAG}`, phone: "305-555-0504" });
    const personId = person.id as string;
    await app.inject({
      method: "POST",
      url: `/people/${personId}/notes`,
      headers: { cookie: adminCookie },
      payload: { body: "clinic A only" },
    });

    const otherCookie = await authenticate(app, SEED.otherClinicAdmin);
    const attempt = await app.inject({
      method: "GET",
      url: `/people/${personId}/notes`,
      headers: { cookie: otherCookie },
    });
    // Row-level security hides the person, so the lookup misses.
    expect(attempt.statusCode).toBe(404);
  });
});

describe("consent ledger (PRD MSG-04)", () => {
  it("tracks channel and purpose independently and keeps full history", async () => {
    const { body: person } = await createPerson({
      firstName: `Consent ${TAG}`,
      phone: "305-555-0600",
      email: `consent.${TAG}@example.test`,
    });
    const personId = person.id as string;

    const record = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/people/${personId}/consent`,
        headers: { cookie: adminCookie },
        payload,
      });

    await record({ channel: "email", purpose: "operational", status: "granted", source: "walk_in_form" });
    await record({ channel: "email", purpose: "promotional", status: "granted", source: "walk_in_form" });
    await record({ channel: "whatsapp", purpose: "operational", status: "granted", source: "whatsapp_inbound" });
    // Later they opt out of marketing email only.
    await record({ channel: "email", purpose: "promotional", status: "withdrawn", source: "unsubscribe_link" });

    const response = await app.inject({
      method: "GET",
      url: `/people/${personId}/consent`,
      headers: { cookie: adminCookie },
    });
    const current = response.json().current as {
      channel: string;
      purpose: string;
      status: string;
    }[];

    const find = (channel: string, purpose: string) =>
      current.find((c) => c.channel === channel && c.purpose === purpose);

    // Withdrawing marketing email must not touch appointment email, nor WhatsApp.
    expect(find("email", "promotional")!.status).toBe("withdrawn");
    expect(find("email", "operational")!.status).toBe("granted");
    expect(find("whatsapp", "operational")!.status).toBe("granted");

    // The ledger is append-only: all four events remain.
    expect((response.json().history as unknown[]).length).toBe(4);
  });
});

describe("merge (PRD ID-06)", () => {
  it("moves notes and consent to the survivor and is reversible", async () => {
    const { body: keep } = await createPerson({
      firstName: `Keep ${TAG}`,
      phone: "305-555-0700",
    });
    const { body: dupe } = await createPerson({
      firstName: `Dupe ${TAG}`,
      phone: "305-555-0700",
      email: `dupe.${TAG}@example.test`,
      allowDuplicate: true,
    });
    const keepId = keep.id as string;
    const dupeId = dupe.id as string;

    await app.inject({
      method: "POST",
      url: `/people/${dupeId}/notes`,
      headers: { cookie: adminCookie },
      payload: { body: "note that must survive the merge" },
    });
    await app.inject({
      method: "POST",
      url: `/people/${dupeId}/consent`,
      headers: { cookie: adminCookie },
      payload: { channel: "email", purpose: "operational", status: "granted", source: "walk_in_form" },
    });

    const merged = await app.inject({
      method: "POST",
      url: `/people/${keepId}/merge`,
      headers: { cookie: adminCookie },
      payload: { mergedPersonId: dupeId, reason: "Same person, called twice" },
    });
    expect(merged.statusCode).toBe(200);
    // The survivor inherits the email the duplicate had and it did not.
    expect(merged.json().email).toBe(`dupe.${TAG}@example.test`);

    const notes = await app.inject({
      method: "GET",
      url: `/people/${keepId}/notes`,
      headers: { cookie: adminCookie },
    });
    expect(notes.json().items).toHaveLength(1);

    const consent = await app.inject({
      method: "GET",
      url: `/people/${keepId}/consent`,
      headers: { cookie: adminCookie },
    });
    expect((consent.json().current as unknown[]).length).toBe(1);

    // The losing record is kept, pointing at the survivor.
    const { db } = getOwnerDb();
    const loser = await db.select().from(people).where(eq(people.id, dupeId));
    expect(loser[0]!.mergedIntoPersonId).toBe(keepId);

    // --- Undo ---
    const merges = await app.inject({
      method: "GET",
      url: "/people/merges",
      headers: { cookie: adminCookie },
    });
    const mergeId = (merges.json().items as { id: string; mergedPersonId: string }[]).find(
      (m) => m.mergedPersonId === dupeId,
    )!.id;

    const reverted = await app.inject({
      method: "POST",
      url: `/people/merges/${mergeId}/revert`,
      headers: { cookie: adminCookie },
    });
    expect(reverted.statusCode).toBe(204);

    const notesAfter = await app.inject({
      method: "GET",
      url: `/people/${keepId}/notes`,
      headers: { cookie: adminCookie },
    });
    expect(notesAfter.json().items).toHaveLength(0);

    const restored = await db.select().from(people).where(eq(people.id, dupeId));
    expect(restored[0]!.mergedIntoPersonId).toBeNull();
  });

  it("refuses to merge a person into themselves", async () => {
    const { body: person } = await createPerson({ firstName: `Self ${TAG}`, phone: "305-555-0701" });
    const id = person.id as string;
    const response = await app.inject({
      method: "POST",
      url: `/people/${id}/merge`,
      headers: { cookie: adminCookie },
      payload: { mergedPersonId: id },
    });
    expect(response.statusCode).toBe(400);
  });

  it("cannot merge a person from another clinic", async () => {
    const { body: mine } = await createPerson({ firstName: `Mine ${TAG}`, phone: "305-555-0702" });

    const otherCookie = await authenticate(app, SEED.otherClinicAdmin);
    const theirs = await createPerson(
      { firstName: `Theirs ${TAG}`, phone: "312-555-0702" },
      otherCookie,
    );

    const response = await app.inject({
      method: "POST",
      url: `/people/${mine.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { mergedPersonId: theirs.body.id },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("field visibility by role", () => {
  it("hides email, address and date of birth from a practitioner", async () => {
    const { body: person } = await createPerson({
      firstName: `Masked ${TAG}`,
      phone: "305-555-0800",
      email: `masked.${TAG}@example.test`,
      addressLine1: "500 Brickell Ave",
      dateOfBirth: "1990-04-17",
    });

    const practitionerCookie = await authenticate(app, SEED.practitioner);
    const response = await app.inject({
      method: "GET",
      url: `/people/${person.id}`,
      headers: { cookie: practitionerCookie },
    });

    expect(response.statusCode).toBe(200);
    const masked = response.json();
    // A practitioner gets the minimum needed for the visit (PRD 2).
    expect(masked.email).toBeNull();
    expect(masked.addressLine1).toBeNull();
    expect(masked.dateOfBirth).toBeNull();
    // Name and phone stay, since they need to identify and reach the person.
    expect(masked.displayName).toContain(TAG);
    expect(masked.phone).toBe("305-555-0800");
  });

  it("returns the full record to front desk", async () => {
    const { body: person } = await createPerson({
      firstName: `Full ${TAG}`,
      phone: "305-555-0801",
      email: `full.${TAG}@example.test`,
    });

    const frontDeskCookie = await authenticate(app, SEED.frontDesk);
    const response = await app.inject({
      method: "GET",
      url: `/people/${person.id}`,
      headers: { cookie: frontDeskCookie },
    });
    expect(response.json().email).toBe(`full.${TAG}@example.test`);
  });

  it("denies a marketing analyst any access to people at all", async () => {
    const marketingCookie = await authenticate(app, SEED.marketing);
    for (const url of ["/people", "/people/duplicates"]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie: marketingCookie } });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it("denies a practitioner the ability to edit a person", async () => {
    const { body: person } = await createPerson({ firstName: `RO ${TAG}`, phone: "305-555-0802" });
    const practitionerCookie = await authenticate(app, SEED.practitioner);
    const response = await app.inject({
      method: "PATCH",
      url: `/people/${person.id}`,
      headers: { cookie: practitionerCookie },
      payload: { firstName: "Changed" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("search", () => {
  it("finds a person by a fragment of their phone number", async () => {
    await createPerson({ firstName: `Findme ${TAG}`, phone: "(305) 555-0910" });

    const response = await app.inject({
      method: "GET",
      url: "/people?search=5550910",
      headers: { cookie: adminCookie },
    });
    const items = response.json().items as { displayName: string }[];
    expect(items.some((p) => p.displayName.includes("Findme"))).toBe(true);
  });

  it("finds a person by name fragment", async () => {
    await createPerson({ firstName: "Wilhelmina", lastName: `Ortiz ${TAG}`, phone: "305-555-0911" });
    const response = await app.inject({
      method: "GET",
      url: "/people?search=Wilhelmina",
      headers: { cookie: adminCookie },
    });
    expect((response.json().items as unknown[]).length).toBeGreaterThan(0);
  });

  it("excludes merged-away records by default", async () => {
    const { body: keep } = await createPerson({ firstName: `MergeHide ${TAG}`, phone: "305-555-0920" });
    const { body: dupe } = await createPerson({
      firstName: `MergeHide Two ${TAG}`,
      phone: "305-555-0920",
      allowDuplicate: true,
    });
    await app.inject({
      method: "POST",
      url: `/people/${keep.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { mergedPersonId: dupe.id },
    });

    const response = await app.inject({
      method: "GET",
      url: `/people?search=MergeHide`,
      headers: { cookie: adminCookie },
    });
    const ids = (response.json().items as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(dupe.id);
  });
});
