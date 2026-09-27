/** Response-time SLA (D-73) and the "Email the team" automation step. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockEmailConnector, MockWhatsAppConnector, resetConnectors, setConnectors } from "@skincrm/connectors";
import { SEED, authenticate, clinicIdBySlug, createTestApp, resetAuthState } from "./helpers";
import { processSlaBreaches } from "../leads/sla";
import { processDueAutomations } from "../worker/jobs";

const { people, leads, leadStageEvents, activities, tasks, clinics, automationRules, automationEnrollments } = schema;
const TAG = "slatest";
let app: FastifyInstance;
let admin: string;
let email: MockEmailConnector;
let clinicId: string;
let before: { minutes: number; escalate: boolean };

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  const c = (await getOwnerDb().db.select().from(clinics).where(eq(clinics.id, clinicId)))[0]!;
  before = { minutes: c.firstResponseSlaMinutes, escalate: c.slaEscalationEnabled };
});
afterAll(async () => {
  await cleanup();
  await getOwnerDb().db.update(clinics).set({ firstResponseSlaMinutes: before.minutes, slaEscalationEnabled: before.escalate }).where(eq(clinics.id, clinicId));
  resetConnectors();
  await app.close();
  await closeAllConnections();
});
beforeEach(async () => {
  await cleanup();
  email = new MockEmailConnector();
  setConnectors({ email, whatsapp: new MockWhatsAppConnector() });
  await getOwnerDb().db.update(clinics).set({ firstResponseSlaMinutes: 30, slaEscalationEnabled: true }).where(eq(clinics.id, clinicId));
});
afterEach(() => undefined);

async function cleanup() {
  const { db } = getOwnerDb();
  await db.delete(automationRules).where(like(automationRules.name, `%${TAG}%`));
  const ids = (await db.select({ id: people.id }).from(people).where(like(people.displayName, `%${TAG}%`))).map((r) => r.id);
  if (!ids.length) return;
  await db.delete(automationEnrollments).where(inArray(automationEnrollments.personId, ids));
  await db.delete(tasks).where(inArray(tasks.personId, ids));
  const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
  if (leadIds.length) {
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }
  await db.delete(activities).where(inArray(activities.personId, ids));
  await db.delete(people).where(inArray(people.id, ids));
}

let n = 0;
async function newLead(extra: Record<string, unknown> = {}) {
  n += 1;
  const r = await app.inject({ method: "POST", url: "/leads", headers: { cookie: admin },
    payload: { person: { firstName: `S${n} ${TAG}`, phone: `305-555-${String(4400 + n)}`, email: `s${n}.${TAG}@example.test`, allowDuplicate: true }, source: "walk_in", ...extra } });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; slaDueAt: string | null; personId: string };
}

describe("response-time SLA", () => {
  it("sets a due time from the clinic's target", async () => {
    const lead = await newLead();
    expect(lead.slaDueAt).not.toBeNull();
    const minutes = (new Date(lead.slaDueAt!).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThan(31);
  });

  it("any logged attempt counts as a response and stops the clock", async () => {
    const lead = await newLead();
    await app.inject({ method: "POST", url: `/leads/${lead.id}/contact-attempts`, headers: { cookie: admin }, payload: { outcome: "no_answer", channel: "phone" } });
    await processSlaBreaches(50, new Date(Date.now() + 2 * 3600_000));
    const row = (await getOwnerDb().db.select().from(leads).where(eq(leads.id, lead.id)))[0]!;
    expect(row.firstResponseAt).not.toBeNull();
    expect(row.slaBreachedAt).toBeNull();
  });

  it("escalates a missed response once: urgent task and an email to admins", async () => {
    const lead = await newLead();
    const later = new Date(Date.now() + 2 * 3600_000);
    await processSlaBreaches(50, later);
    await processSlaBreaches(50, later);
    const row = (await getOwnerDb().db.select().from(leads).where(eq(leads.id, lead.id)))[0]!;
    expect(row.slaBreachedAt).not.toBeNull();
    const t = await getOwnerDb().db.select().from(tasks).where(eq(tasks.leadId, lead.id));
    expect(t).toHaveLength(1);
    expect(t[0]!.priority).toBe("urgent");
    expect(email.outbox().filter((m) => m.subject?.startsWith("Missed response time"))).toHaveLength(1);
  });

  it("can be switched off", async () => {
    const off = await app.inject({ method: "PATCH", url: "/settings/lead-rules", headers: { cookie: admin }, payload: { firstResponseSlaMinutes: 0, slaEscalationEnabled: false } });
    expect(off.statusCode).toBe(200);
    expect((await newLead()).slaDueAt).toBeNull();
  });

  it("front desk can't change it", async () => {
    const fd = await authenticate(app, SEED.frontDesk);
    const r = await app.inject({ method: "PATCH", url: "/settings/lead-rules", headers: { cookie: fd }, payload: { firstResponseSlaMinutes: 15, slaEscalationEnabled: true } });
    expect(r.statusCode).toBe(403);
  });
});

describe("Email the team step", () => {
  it("emails admins and extra addresses about a new lead", async () => {
    const created = await app.inject({ method: "POST", url: "/automations", headers: { cookie: admin }, payload: {
      name: `Alert ${TAG}`, trigger: { type: "lead_created", sources: [] }, stopWhen: [],
      steps: [{ id: "s1", type: "notify_team", audiences: ["admins"], userIds: [], extraEmails: ["Traveller@Example.test"], includeContact: true }],
    } });
    expect(created.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/automations/${created.json().id}/status`, headers: { cookie: admin }, payload: { status: "active" } });

    const lead = await newLead();
    await processDueAutomations();
    const alerts = email.outbox().filter((m) => m.subject?.startsWith("New lead:"));
    expect(alerts.map((m) => m.to)).toContain(SEED.admin);
    expect(alerts.map((m) => m.to)).toContain("traveller@example.test");
    expect(alerts[0]!.body).toContain(`/leads/${lead.id}`);
    expect(alerts[0]!.body).toContain("Phone:");
  });

  it("refuses an empty recipient list", async () => {
    const r = await app.inject({ method: "POST", url: "/automations", headers: { cookie: admin }, payload: {
      name: `Empty ${TAG}`, trigger: { type: "lead_created", sources: [] }, stopWhen: [],
      steps: [{ id: "s1", type: "notify_team", audiences: [], userIds: [], extraEmails: [], includeContact: true }],
    } });
    expect(r.statusCode).toBe(400);
  });
});
