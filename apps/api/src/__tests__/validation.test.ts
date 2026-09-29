/**
 * Contact-field rules (D-89): strict where staff type, forgiving where leads
 * arrive from outside, so no real lead is ever lost to a messy detail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { createLeadSchema, isValidEmail, nameProblem, phoneShapeProblem, sanitizePhoneInput, updatePersonSchema } from "@skincrm/contracts";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";
import { validateRow } from "../intake/csv";

const { people, leads, leadStageEvents, activities, tasks, sourceSubmissions, clinics } = schema;
const TAG = "valtest";
let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
});
afterAll(async () => {
  const { db } = getOwnerDb();
  const ids = (await db.select({ id: people.id }).from(people)
    .where(or(like(people.displayName, `%${TAG}%`), like(people.emailRaw, `%${TAG}%`), like(people.lastName, `%Valtest%`)))).map((r) => r.id);
  if (ids.length) {
    const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
    if (leadIds.length) await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
    await db.delete(activities).where(inArray(activities.personId, ids));
    await db.delete(tasks).where(inArray(tasks.personId, ids));
    await db.delete(leads).where(inArray(leads.personId, ids));
    await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.personId, ids));
    await db.delete(people).where(inArray(people.id, ids));
  }
  await app.close();
  await closeAllConnections();
});

const newLead = (person: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/leads", headers: { cookie: admin }, payload: { source: "walk_in", person } });

describe("the rules themselves", () => {
  it("phones: phone characters only, 7–15 digits; letters are stripped as you type", () => {
    expect(phoneShapeProblem("abc")).toMatch(/only contain digits/);
    expect(phoneShapeProblem("305 555 01x3")).toMatch(/only contain digits/);
    expect(phoneShapeProblem("12345")).toMatch(/too short/);
    expect(phoneShapeProblem("+1 (305) 555-0123")).toBeNull();
    expect(sanitizePhoneInput("30a5-55b5+0123")).toBe("305-5550123");
    expect(sanitizePhoneInput("+1 305")).toBe("+1 305");
  });

  it("emails: a whole address; digits are fine, a bare number is not", () => {
    expect(isValidEmail("jane.doe85@gmail.com")).toBe(true);
    expect(isValidEmail("12345")).toBe(false);
    expect(isValidEmail("jane@gmail")).toBe(false);
    expect(isValidEmail("jane @gmail.com")).toBe(false);
  });

  it("names: letters, spaces, apostrophes, hyphens; no digits", () => {
    expect(nameProblem("Anne-Marie O'Neil")).toBeNull();
    expect(nameProblem("José Núñez")).toBeNull();
    expect(nameProblem("John3")).toMatch(/numbers/);
    expect(nameProblem("a@b")).toBeTruthy();
  });

  it("the Add lead and Edit patient contracts apply them", () => {
    expect(createLeadSchema.safeParse({ person: { phone: "call me" } }).success).toBe(false);
    expect(createLeadSchema.safeParse({ person: { email: "98765" } }).success).toBe(false);
    const ok = createLeadSchema.parse({ person: { firstName: "Ana", phone: "305 555 0142", email: "Ana.Lopez@Example.com" } });
    expect(ok.person?.email).toBe("Ana.Lopez@Example.com");
    expect(updatePersonSchema.safeParse({ city: "Miami 33" }).success).toBe(false);
    expect(updatePersonSchema.safeParse({ postalCode: "33132" }).success).toBe(true);
    expect(updatePersonSchema.safeParse({ dateOfBirth: "2999-01-01" }).success).toBe(false);
  });
});

describe("typed by staff: refused with a message on the field", () => {
  it("Add lead refuses letters in the phone, a non-address email and digits in a name", async () => {
    const phone = await newLead({ firstName: "Ana", phone: "abcdefgh" });
    expect(phone.statusCode).toBe(400);
    expect(Object.keys(phone.json().error.details)).toContain("person.phone");

    const email = await newLead({ firstName: "Ana", email: "12345" });
    expect(email.statusCode).toBe(400);
    expect(email.json().error.details["person.email"][0]).toMatch(/full email address/);

    const name = await newLead({ firstName: "Ana2", phone: "305 555 0142" });
    expect(name.statusCode).toBe(400);
  });

  it("refuses a well-formed but impossible number, and accepts a foreign one with its code", async () => {
    const fake = await newLead({ firstName: "Ana", lastName: "Valtest", phone: "000 000 0000" });
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.message).toMatch(/isn't a valid phone number/);

    const uk = await newLead({ firstName: "Nigel", lastName: "Valtest", phone: "+44 20 7946 0958", email: `nigel.${TAG}@example.test` });
    expect(uk.statusCode).toBe(201);
  });

  it("editing another field of a patient whose imported phone is unreadable still works", async () => {
    const { db } = getOwnerDb();
    const [clinic] = await db.select({ id: clinics.id }).from(clinics).where(eq(clinics.slug, SEED.clinicA));
    const [person] = await db.insert(people).values({
      clinicId: clinic!.id, firstName: "Imported", lastName: "Valtest", displayName: `Imported ${TAG}`,
      phoneRaw: "ask at desk", phoneValid: false, emailRaw: `imported.${TAG}@example.test`, emailNormalized: `imported.${TAG}@example.test`,
    }).returning({ id: people.id });

    const edit = await app.inject({ method: "PATCH", url: `/people/${person!.id}`, headers: { cookie: admin }, payload: { phone: "ask at desk", city: "Tampa" } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().city).toBe("Tampa");
  });

  it("clinic profile and messaging settings check their phone, website, email and domain", async () => {
    const bad = await app.inject({ method: "PATCH", url: "/settings/clinic", headers: { cookie: admin },
      payload: { name: "Sunshine Skin & Laser", timezone: "America/New_York", phone: "front desk", website: "not a site", supportEmail: "12345" } });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().error.details).sort()).toEqual(["phone", "supportEmail", "website"]);

    const settings = await app.inject({ method: "PATCH", url: "/settings/messaging", headers: { cookie: admin },
      payload: { sendingDomain: "https://clinic.com/", supportEmail: "desk" } });
    expect(settings.statusCode).toBe(400);
    expect(Object.keys(settings.json().error.details).sort()).toEqual(["sendingDomain", "supportEmail"]);

    const test = await app.inject({ method: "POST", url: "/integrations/test-send", headers: { cookie: admin }, payload: { channel: "email", to: "555-0100" } });
    expect(test.statusCode).toBe(400);
  });

  it("staff invites need a real name", async () => {
    const invite = await app.inject({ method: "POST", url: "/users", headers: { cookie: admin },
      payload: { email: `x.${TAG}@sunshine-skin.test`, fullName: "12345", role: "front_desk" } });
    expect(invite.statusCode).toBe(400);
  });
});

describe("arriving from outside: never lost, never polluting", () => {
  async function formKey() {
    return (await app.inject({ method: "POST", url: "/settings/website-form-key", headers: { cookie: admin } })).json().key as string;
  }

  it("a website lead with a broken email and a good phone arrives; the email goes into the note", async () => {
    const key = await formKey();
    const response = await app.inject({ method: "POST", url: "/webhooks/website",
      payload: { key, firstName: "Rosa", lastName: `Web ${TAG}`, phone: "305-555-0177", email: "rosa at gmail" } });
    expect(response.statusCode).toBe(202);
    const { db } = getOwnerDb();
    const [person] = await db.select().from(people).where(like(people.displayName, `Rosa Web ${TAG}`));
    expect(person!.emailRaw).toBeNull();
    const [lead] = await db.select().from(leads).where(eq(leads.personId, person!.id));
    expect(lead!.inquiryNote).toContain(`"rosa at gmail"`);
  });

  it("a website lead with nothing usable is refused", async () => {
    const key = await formKey();
    const response = await app.inject({ method: "POST", url: "/webhooks/website", payload: { key, firstName: "Bot", phone: "n/a", email: "none" } });
    expect(response.statusCode).toBe(400);
  });

  it("CSV: an unreadable phone is kept with a warning; a non-address email is an error", () => {
    const row = validateRow({ Name: "Kim Valtest", Phone: "ext 12", Email: "kim@" }, { fullName: "Name", phone: "Phone", email: "Email" }, 1, "US");
    expect(row.valid).toBe(false);
    expect(row.errors.join(" ")).toMatch(/email address/);
    const kept = validateRow({ Name: "Kim Valtest", Phone: "305 555 01", Email: "kim@example.test" }, { fullName: "Name", phone: "Phone", email: "Email" }, 2, "US");
    expect(kept.valid).toBe(true);
    expect(kept.warnings.join(" ")).toMatch(/kept as written/);
  });
});
