/**
 * Assignment rules and intake (PRD LEAD-03, ID-04, ID-05, ID-07).
 *
 * Requires a migrated and seeded database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";

const { people, leads, tasks, activities, leadStageEvents, assignmentRules, sourceSubmissions, rawPayloads, consentRecords, clinics } =
  schema;

let app: FastifyInstance;
let adminCookie: string;
let staff: Record<string, string>;

const TAG = "intaketest";

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  adminCookie = await authenticate(app, SEED.admin);

  const response = await app.inject({ method: "GET", url: "/users", headers: { cookie: adminCookie } });
  staff = Object.fromEntries(
    (response.json().items as { id: string; email: string }[]).map((u) => [u.email, u.id]),
  );
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
  await db.delete(assignmentRules).where(like(assignmentRules.name, `%${TAG}%`));

  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(or(like(people.displayName, `%${TAG}%`), like(people.emailRaw, `%${TAG}%`)));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;

  const leadRows = await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids));
  const leadIds = leadRows.map((r) => r.id);
  if (leadIds.length > 0) {
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
  }
  await db.delete(activities).where(inArray(activities.personId, ids));
  await db.delete(tasks).where(inArray(tasks.personId, ids));
  await db.delete(consentRecords).where(inArray(consentRecords.personId, ids));
  await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.personId, ids));
  if (leadIds.length > 0) await db.delete(leads).where(inArray(leads.id, leadIds));
  await db.delete(people).where(inArray(people.id, ids));
}

function createRule(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/assignment-rules",
    headers: { cookie: adminCookie },
    payload: { name: `Rule ${TAG}`, priority: 10, ...payload },
  });
}

let phoneCounter = 2000;
function nextPhone(): string {
  phoneCounter += 1;
  return `305-555-${String(phoneCounter).padStart(4, "0")}`;
}

function createLead(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/leads",
    headers: { cookie: adminCookie },
    payload: {
      person: { firstName: `Routed ${TAG}`, phone: nextPhone(), allowDuplicate: true },
      source: "walk_in",
      ...overrides,
    },
  });
}

describe("assignment rules (PRD LEAD-03)", () => {
  it("assigns a new lead to the matching rule's owner", async () => {
    await createRule({ assignMode: "user", assignUserId: staff[SEED.frontDesk] });

    const lead = await createLead();
    expect(lead.statusCode).toBe(201);
    expect(lead.json().ownerUserId).toBe(staff[SEED.frontDesk]);
    expect(lead.json().ownerName).toBe("Priya Raman");
  });

  it("evaluates in priority order and stops at the first match", async () => {
    await createRule({
      name: `Low priority catch-all ${TAG}`,
      priority: 50,
      assignMode: "user",
      assignUserId: staff[SEED.frontDesk],
    });
    await createRule({
      name: `High priority botox ${TAG}`,
      priority: 5,
      matchServiceInterest: "botox",
      assignMode: "user",
      assignUserId: staff[SEED.practitioner],
    });

    const matching = await createLead({ serviceInterest: "Botox consultation" });
    expect(matching.json().ownerUserId).toBe(staff[SEED.practitioner]);

    // Anything the specific rule does not match falls through to the catch-all.
    const other = await createLead({ serviceInterest: "Skin check" });
    expect(other.json().ownerUserId).toBe(staff[SEED.frontDesk]);
  });

  it("matches service interest case-insensitively as a substring", async () => {
    await createRule({
      matchServiceInterest: "LASER",
      assignMode: "user",
      assignUserId: staff[SEED.practitioner],
    });
    const lead = await createLead({ serviceInterest: "interested in laser hair removal" });
    expect(lead.json().ownerUserId).toBe(staff[SEED.practitioner]);
  });

  it("matches on source", async () => {
    await createRule({
      matchSource: "phone",
      assignMode: "user",
      assignUserId: staff[SEED.practitioner],
    });

    const phoneLead = await createLead({ source: "phone" });
    expect(phoneLead.json().ownerUserId).toBe(staff[SEED.practitioner]);

    const walkIn = await createLead({ source: "walk_in" });
    expect(walkIn.json().ownerUserId).toBeNull();
  });

  it("leaves the lead in the unassigned queue when nothing matches", async () => {
    await createRule({
      matchSource: "google_lead_form",
      assignMode: "user",
      assignUserId: staff[SEED.frontDesk],
    });
    const lead = await createLead({ source: "walk_in" });
    expect(lead.json().ownerUserId).toBeNull();
  });

  it("honours an explicit owner over the rules", async () => {
    await createRule({ assignMode: "user", assignUserId: staff[SEED.frontDesk] });
    const lead = await createLead({ ownerUserId: staff[SEED.practitioner] });
    expect(lead.json().ownerUserId).toBe(staff[SEED.practitioner]);
  });

  it("cycles through a round-robin pool", async () => {
    const pool = [staff[SEED.frontDesk]!, staff[SEED.frontDesk2]!];
    await createRule({ assignMode: "round_robin", poolUserIds: pool });

    const owners: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      owners.push((await createLead()).json().ownerUserId);
    }

    // Alternating, and every lead got someone.
    expect(owners.every((o) => o !== null)).toBe(true);
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[0]).toBe(owners[2]);
    expect(owners[1]).toBe(owners[3]);
  });

  it("records which rule made the assignment on the timeline", async () => {
    await createRule({ name: `Named rule ${TAG}`, assignMode: "user", assignUserId: staff[SEED.frontDesk] });
    const lead = await createLead();

    const timeline = await app.inject({
      method: "GET",
      url: `/leads/${lead.json().id}/timeline`,
      headers: { cookie: adminCookie },
    });
    const summaries = (timeline.json().items as { summary: string }[]).map((a) => a.summary);
    expect(summaries.some((s) => s.includes(`Named rule ${TAG}`))).toBe(true);
  });

  it("falls through when the rule's assignee is no longer active", async () => {
    await createRule({
      priority: 5,
      assignMode: "user",
      assignUserId: staff[SEED.frontDesk2],
    });
    await createRule({
      name: `Fallback ${TAG}`,
      priority: 20,
      assignMode: "user",
      assignUserId: staff[SEED.frontDesk],
    });

    const { db } = getOwnerDb();
    await db.update(schema.users).set({ status: "suspended" }).where(eq(schema.users.id, staff[SEED.frontDesk2]!));
    try {
      const lead = await createLead();
      // A departed colleague must not silently absorb new work.
      expect(lead.json().ownerUserId).toBe(staff[SEED.frontDesk]);
    } finally {
      await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, staff[SEED.frontDesk2]!));
    }
  });

  it("refuses two rules at the same priority, so order is never ambiguous", async () => {
    await createRule({ priority: 7, assignMode: "user", assignUserId: staff[SEED.frontDesk] });
    const clash = await createRule({
      name: `Clash ${TAG}`,
      priority: 7,
      assignMode: "user",
      assignUserId: staff[SEED.frontDesk],
    });
    expect(clash.statusCode).toBe(409);
  });

  it("refuses a rule that cannot name anyone", async () => {
    expect((await createRule({ assignMode: "user" })).statusCode).toBe(400);
    expect((await createRule({ assignMode: "round_robin", poolUserIds: [] })).statusCode).toBe(400);
  });

  it("refuses a rule pointing at another clinic's staff", async () => {
    const { db } = getOwnerDb();
    const foreign = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, SEED.otherClinicAdmin));
    const response = await createRule({ assignMode: "user", assignUserId: foreign[0]!.id });
    expect(response.statusCode).toBe(400);
  });

  it("previews which rule would match without creating anything", async () => {
    await createRule({ matchServiceInterest: "peel", assignMode: "user", assignUserId: staff[SEED.frontDesk] });

    const hit = await app.inject({
      method: "POST",
      url: "/assignment-rules/preview",
      headers: { cookie: adminCookie },
      payload: { source: "walk_in", serviceInterest: "chemical peel" },
    });
    expect(hit.json().matched).toBe(true);

    const miss = await app.inject({
      method: "POST",
      url: "/assignment-rules/preview",
      headers: { cookie: adminCookie },
      payload: { source: "walk_in", serviceInterest: "something else" },
    });
    expect(miss.json().matched).toBe(false);
  });

  it("denies rule management to front desk", async () => {
    const frontDeskCookie = await authenticate(app, SEED.frontDesk);
    const response = await app.inject({
      method: "GET",
      url: "/assignment-rules",
      headers: { cookie: frontDeskCookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

// --- CSV import -----------------------------------------------------------

function csvFor(rows: string[]): string {
  return ["First Name,Last Name,Phone,Email,Service", ...rows].join("\n");
}

function importCsv(csv: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/imports/csv",
    headers: { cookie: adminCookie },
    payload: {
      csv,
      mapping: {
        firstName: "First Name",
        lastName: "Last Name",
        phone: "Phone",
        email: "Email",
        serviceInterest: "Service",
      },
      ...extra,
    },
  });
}

describe("CSV import (PRD ID-04)", () => {
  it("suggests a mapping from the column headers", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/imports/csv/preview",
      headers: { cookie: adminCookie },
      payload: { csv: csvFor([`Ana,Lopez ${TAG},305-555-3001,ana.${TAG}@example.test,Botox`]) },
    });
    expect(response.statusCode).toBe(200);
    const mapping = response.json().mapping as Record<string, string>;
    expect(mapping.firstName).toBe("First Name");
    expect(mapping.phone).toBe("Phone");
    expect(mapping.email).toBe("Email");
  });

  it("reports invalid rows in the preview without importing anything", async () => {
    const csv = csvFor([
      `Ana,Lopez ${TAG},305-555-3002,ana2.${TAG}@example.test,Botox`,
      `NoContact,Person ${TAG},,,Botox`,
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/imports/csv/preview",
      headers: { cookie: adminCookie },
      payload: { csv },
    });
    expect(response.json().validRows).toBe(1);
    expect(response.json().invalidRows).toBe(1);

    const { db } = getOwnerDb();
    const imported = await db.select().from(people).where(like(people.displayName, `%${TAG}%`));
    expect(imported).toHaveLength(0);
  });

  it("imports valid rows and skips invalid ones", async () => {
    const csv = csvFor([
      `Ana,Lopez ${TAG},305-555-3003,ana3.${TAG}@example.test,Botox`,
      `Broken,Row ${TAG},,,Botox`,
      `Ben,Ortiz ${TAG},305-555-3004,ben.${TAG}@example.test,Laser`,
    ]);

    const response = await importCsv(csv);
    expect(response.statusCode).toBe(200);
    expect(response.json().created).toBe(2);
    expect(response.json().failed).toBe(1);
    expect((response.json().failures as { rowNumber: number }[])[0]!.rowNumber).toBe(2);
  });

  it("does not duplicate when the same file is imported twice (PRD ID-07)", async () => {
    const csv = csvFor([
      `Cara,Nunez ${TAG},305-555-3010,cara.${TAG}@example.test,Peel`,
      `Dan,Reyes ${TAG},305-555-3011,dan.${TAG}@example.test,Peel`,
    ]);

    const first = await importCsv(csv);
    expect(first.json().created).toBe(2);
    expect(first.json().duplicates).toBe(0);

    const second = await importCsv(csv);
    // Every row hits the unique index on (clinic, platform, external_id).
    expect(second.json().created).toBe(0);
    expect(second.json().duplicates).toBe(2);

    const { db } = getOwnerDb();
    const imported = await db.select().from(people).where(like(people.displayName, `%${TAG}%`));
    expect(imported).toHaveLength(2);
  });

  it("links a second import to the existing person rather than duplicating them", async () => {
    await importCsv(csvFor([`Eve,Salas ${TAG},305-555-3020,eve.${TAG}@example.test,Peel`]));
    // Same person, different file, so different row ids: a genuine new inquiry.
    await importCsv(csvFor([`Eve,Salas ${TAG},305-555-3020,eve.${TAG}@example.test,Laser`]));

    const { db } = getOwnerDb();
    const matched = await db.select().from(people).where(like(people.displayName, `%Salas ${TAG}%`));
    expect(matched).toHaveLength(1);

    const theirLeads = await db.select().from(leads).where(eq(leads.personId, matched[0]!.id));
    // One person, two inquiries (BRD 2).
    expect(theirLeads).toHaveLength(2);
  });

  it("handles quoted fields, embedded commas and CRLF line endings", async () => {
    const csv = [
      "First Name,Last Name,Phone,Email,Service",
      `"Fay","Quinn ${TAG}","305-555-3030","fay.${TAG}@example.test","Botox, filler and peel"`,
    ].join("\r\n");

    const response = await importCsv(csv);
    expect(response.json().created).toBe(1);

    const { db } = getOwnerDb();
    const person = await db.select().from(people).where(like(people.displayName, `%Quinn ${TAG}%`));
    const lead = await db.select().from(leads).where(eq(leads.personId, person[0]!.id));
    expect(lead[0]!.serviceInterest).toBe("Botox, filler and peel");
  });

  it("strips the byte-order mark Excel writes", async () => {
    const csv = "﻿" + csvFor([`Gil,Roman ${TAG},305-555-3040,gil.${TAG}@example.test,Peel`]);
    const preview = await app.inject({
      method: "POST",
      url: "/imports/csv/preview",
      headers: { cookie: adminCookie },
      payload: { csv },
    });
    // Without stripping, the first header becomes "﻿First Name" and never maps.
    expect((preview.json().headers as string[])[0]).toBe("First Name");
    expect((preview.json().mapping as Record<string, string>).firstName).toBe("First Name");
  });

  it("keeps an unreadable phone as a warning rather than rejecting the row", async () => {
    const csv = csvFor([`Hal,Vega ${TAG},ask reception,hal.${TAG}@example.test,Peel`]);
    const preview = await app.inject({
      method: "POST",
      url: "/imports/csv/preview",
      headers: { cookie: adminCookie },
      payload: { csv },
    });
    expect(preview.json().validRows).toBe(1);
    expect(JSON.stringify(preview.json().problems)).toMatch(/could not be read/i);
  });

  it("routes imported leads through the assignment rules", async () => {
    await createRule({ assignMode: "user", assignUserId: staff[SEED.frontDesk] });
    await importCsv(csvFor([`Ivy,Marsh ${TAG},305-555-3050,ivy.${TAG}@example.test,Peel`]));

    const { db } = getOwnerDb();
    const person = await db.select().from(people).where(like(people.displayName, `%Marsh ${TAG}%`));
    const lead = await db.select().from(leads).where(eq(leads.personId, person[0]!.id));
    expect(lead[0]!.ownerUserId).toBe(staff[SEED.frontDesk]);
  });
});

// --- Website endpoint -----------------------------------------------------

describe("website lead endpoint (PRD ID-05)", () => {
  async function issueKey(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/settings/website-form-key",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json().key as string;
  }

  function submit(key: string, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/webhooks/website", payload: { key, ...payload } });
  }

  it("accepts a submission and creates a person and lead", async () => {
    const key = await issueKey();
    const response = await submit(key, {
      firstName: "Jo",
      lastName: `Webb ${TAG}`,
      email: `jo.${TAG}@example.test`,
      phone: "305-555-3100",
      serviceInterest: "Consultation",
      message: "Mornings work best",
      consentGiven: true,
      consentText: "I agree to be contacted about my enquiry.",
      consentVersion: "v1",
      utmSource: "google",
      utmCampaign: "spring",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("received");

    const { db } = getOwnerDb();
    const person = await db.select().from(people).where(like(people.displayName, `%Webb ${TAG}%`));
    expect(person).toHaveLength(1);

    const lead = await db.select().from(leads).where(eq(leads.personId, person[0]!.id));
    expect(lead[0]!.source).toBe("website_form");

    // Consent is recorded with its wording and version (PRD ID-05, MSG-04).
    const consent = await db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.personId, person[0]!.id));
    expect(consent).toHaveLength(1);
    expect(consent[0]!.noticeVersion).toBe("v1");
    expect(consent[0]!.capturedText).toContain("I agree");
    expect(consent[0]!.evidenceReference).toMatch(/^source_submission:/);

    // Attribution is preserved (PRD INT-05).
    const submission = await db
      .select()
      .from(sourceSubmissions)
      .where(eq(sourceSubmissions.leadId, lead[0]!.id));
    expect(submission[0]!.utmSource).toBe("google");
    expect(submission[0]!.utmCampaign).toBe("spring");
  });

  it("stores the raw payload encrypted, without the key", async () => {
    const key = await issueKey();
    await submit(key, {
      firstName: "Kit",
      lastName: `Rowe ${TAG}`,
      email: `kit.${TAG}@example.test`,
    });

    const { db } = getOwnerDb();
    const payloads = await db.select().from(rawPayloads).where(eq(rawPayloads.platform, "website"));
    const latest = payloads.at(-1)!;
    // Encrypted at rest, and the form key is never among what is stored.
    expect(latest.encryptedPayload).not.toContain("Rowe");
    expect(latest.encryptedPayload).not.toContain(key);
    expect(latest.encryptedPayload.startsWith("v1:")).toBe(true);
  });

  it("rejects a wrong or missing key", async () => {
    expect((await submit("not-a-real-key-value", { email: `x.${TAG}@example.test` })).statusCode).toBe(401);
    const noKey = await app.inject({
      method: "POST",
      url: "/webhooks/website",
      payload: { email: `y.${TAG}@example.test` },
    });
    expect(noKey.statusCode).toBe(400);
  });

  it("requires a phone or an email", async () => {
    const key = await issueKey();
    const response = await submit(key, { firstName: `NoContact ${TAG}` });
    expect(response.statusCode).toBe(400);
  });

  it("silently absorbs a honeypot submission", async () => {
    const key = await issueKey();
    const response = await submit(key, {
      firstName: `Bot ${TAG}`,
      email: `bot.${TAG}@example.test`,
      website: "http://spam.example",
    });

    // Answers exactly like a success, so the bot learns nothing.
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("received");

    const { db } = getOwnerDb();
    const person = await db.select().from(people).where(like(people.emailRaw, `bot.${TAG}%`));
    expect(person).toHaveLength(0);
  });

  it("rotating the key invalidates the old one", async () => {
    const firstKey = await issueKey();
    const secondKey = await issueKey();
    expect(firstKey).not.toBe(secondKey);

    expect((await submit(firstKey, { email: `old.${TAG}@example.test` })).statusCode).toBe(401);
    expect((await submit(secondKey, { email: `new.${TAG}@example.test` })).statusCode).toBe(202);
  });

  it("links a website submission to an existing person by email", async () => {
    const key = await issueKey();
    await submit(key, { firstName: "Lena", lastName: `Cruz ${TAG}`, email: `lena.${TAG}@example.test` });
    await submit(key, { firstName: "Lena", lastName: `Cruz ${TAG}`, email: `LENA.${TAG}@example.test` });

    const { db } = getOwnerDb();
    const person = await db.select().from(people).where(like(people.displayName, `%Cruz ${TAG}%`));
    // Matched on the normalized email despite the different case.
    expect(person).toHaveLength(1);
    const theirLeads = await db.select().from(leads).where(eq(leads.personId, person[0]!.id));
    expect(theirLeads).toHaveLength(2);
  });

  it("does not leak the submission into another clinic", async () => {
    const key = await issueKey();
    await submit(key, { firstName: "Mo", lastName: `Tan ${TAG}`, email: `mo.${TAG}@example.test` });

    const otherCookie = await authenticate(app, SEED.otherClinicAdmin);
    const response = await app.inject({
      method: "GET",
      url: `/people?search=Tan ${TAG}`,
      headers: { cookie: otherCookie },
    });
    expect(response.json().items).toHaveLength(0);
  });
});
