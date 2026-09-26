/**
 * Automation engine (PRD MSG-03, MSG-05, MSG-06, CAL-05).
 *
 * Runs are advanced by calling the worker's job directly with an explicit
 * "now", so waits of hours or days are tested without waiting. Requires a
 * migrated and seeded database, and no dev worker running against it (a live
 * worker would claim these runs first).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AUTOMATION_RECIPES, saveAutomationSchema } from "@skincrm/contracts";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockEmailConnector, MockWhatsAppConnector, resetConnectors, setConnectors } from "@skincrm/connectors";
import { resetEnvCache } from "@skincrm/config";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";
import { processDueAutomations } from "../worker/jobs";
import { clinicLocalToUtc } from "../calendar/timezone";

const {
  automationRules,
  automationEnrollments,
  people,
  leads,
  leadStageEvents,
  activities,
  tasks,
  messages,
  appointments,
  clinics,
  users,
} = schema;

const TAG = "autotest";
const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let adminCookie: string;
let email: MockEmailConnector;
let practitionerId: string;

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  adminCookie = await authenticate(app, SEED.admin);
  const { db } = getOwnerDb();
  practitionerId = (await db.select({ id: users.id }).from(users).where(eq(users.email, SEED.practitioner)))[0]!.id;
});

afterAll(async () => {
  await cleanup();
  await setQuietHours("21:00", "08:00");
  resetConnectors();
  await app.close();
  await closeAllConnections();
});

beforeEach(async () => {
  await cleanup();
  email = new MockEmailConnector();
  setConnectors({ email, whatsapp: new MockWhatsAppConnector() });
  process.env.OUTBOUND_SENDING_ENABLED = "true";
  resetEnvCache();
  await setQuietHours("00:00", "00:00");
});

afterEach(() => {
  delete process.env.OUTBOUND_SENDING_ENABLED;
  resetEnvCache();
});

async function cleanup(): Promise<void> {
  const { db } = getOwnerDb();
  await db.delete(automationRules).where(like(automationRules.name, `%${TAG}%`));
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(or(like(people.displayName, `%${TAG}%`), like(people.emailRaw, `%${TAG}%`)));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(automationEnrollments).where(inArray(automationEnrollments.personId, ids));
  await db.delete(messages).where(inArray(messages.personId, ids));
  await db.delete(tasks).where(inArray(tasks.personId, ids));
  await db.delete(appointments).where(inArray(appointments.personId, ids));
  const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
  if (leadIds.length) {
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }
  await db.delete(activities).where(inArray(activities.personId, ids));
  await db.delete(people).where(inArray(people.id, ids));
}

async function setQuietHours(start: string, end: string): Promise<void> {
  await getOwnerDb().db.update(clinics).set({ quietHoursStart: start, quietHoursEnd: end });
}

let counter = 0;
async function createLead(): Promise<{ id: string; personId: string; email: string }> {
  counter += 1;
  const address = `lead${counter}.${TAG}@example.test`;
  const response = await app.inject({
    method: "POST",
    url: "/leads",
    headers: { cookie: adminCookie },
    payload: {
      person: {
        firstName: `Dana ${TAG}`,
        email: address,
        phone: `305-555-${String(6000 + counter).padStart(4, "0")}`,
        allowDuplicate: true,
      },
      source: "walk_in",
    },
  });
  if (response.statusCode !== 201) throw new Error(`createLead failed: ${response.body}`);
  return { id: response.json().id, personId: response.json().personId, email: address };
}

async function saveRule(rule: Record<string, unknown>, activate = true): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/automations",
    headers: { cookie: adminCookie },
    payload: { stopWhen: [], ...rule, name: `${rule.name ?? "Rule"} ${TAG}` },
  });
  if (created.statusCode !== 201) throw new Error(`saveRule failed: ${created.body}`);
  const id = created.json().id as string;
  if (activate) {
    const on = await app.inject({
      method: "POST",
      url: `/automations/${id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: "active" },
    });
    expect(on.statusCode).toBe(200);
  }
  return id;
}

async function runsFor(ruleId: string) {
  return getOwnerDb().db.select().from(automationEnrollments).where(eq(automationEnrollments.ruleId, ruleId));
}

const thankYou = {
  id: "s1",
  type: "send_email",
  purpose: "operational",
  subject: "Thanks from {{clinic.name}}",
  body: "Hi {{person.firstName}}, thanks for getting in touch.",
};

describe("rule validation", () => {
  it("accepts every built-in recipe", () => {
    for (const recipe of AUTOMATION_RECIPES) {
      expect(saveAutomationSchema.safeParse(recipe.rule).success, recipe.key).toBe(true);
    }
  });

  it("refuses a rule that only waits", () => {
    const result = saveAutomationSchema.safeParse({
      name: "Idle",
      trigger: { type: "lead_created" },
      steps: [{ id: "a", type: "wait", amount: 1, unit: "hours" }],
    });
    expect(result.success).toBe(false);
  });

  it("starts new automations paused", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/automations",
      headers: { cookie: adminCookie },
      payload: { name: `Paused ${TAG}`, trigger: { type: "lead_created" }, steps: [thankYou] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("paused");
  });

  it("refuses unknown variables and missing templates on save", async () => {
    const badVariable = await app.inject({
      method: "POST",
      url: "/automations",
      headers: { cookie: adminCookie },
      payload: {
        name: `Bad ${TAG}`,
        trigger: { type: "lead_created" },
        steps: [{ ...thankYou, body: "Hi {{person.diagnosis}}" }],
      },
    });
    expect(badVariable.statusCode).toBe(400);
    expect(JSON.stringify(badVariable.json())).toMatch(/person\.diagnosis/);

    const badTemplate = await app.inject({
      method: "POST",
      url: "/automations",
      headers: { cookie: adminCookie },
      payload: {
        name: `Bad ${TAG}`,
        trigger: { type: "lead_created" },
        steps: [{ id: "s1", type: "send_email", purpose: "operational", templateKey: "does_not_exist" }],
      },
    });
    expect(badTemplate.statusCode).toBe(400);
  });

  it("refuses a retired pipeline stage", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/automations",
      headers: { cookie: adminCookie },
      payload: {
        name: `Retired ${TAG}`,
        trigger: { type: "stage_changed", stageCategory: "qualified" },
        steps: [thankYou],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("running (PRD MSG-03)", () => {
  it("does nothing while the rule is paused", async () => {
    const ruleId = await saveRule({ name: "Off", trigger: { type: "lead_created" }, steps: [thankYou] }, false);
    await createLead();
    expect(await runsFor(ruleId)).toHaveLength(0);
  });

  it("sends to a new lead, logs it against the rule, and never twice", async () => {
    const ruleId = await saveRule({ name: "Thanks", trigger: { type: "lead_created" }, steps: [thankYou] });
    const lead = await createLead();

    const runs = await runsFor(ruleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("active");

    await processDueAutomations();
    const sent = email.outbox().filter((m) => m.to === lead.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Hi Dana");

    const [run] = await runsFor(ruleId);
    expect(run!.state).toBe("completed");
    expect(run!.history.at(-1)!.outcome).toBe("done");

    const logged = await getOwnerDb().db.select().from(messages).where(eq(messages.personId, lead.personId));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.ruleId).toBe(ruleId);

    // A replayed tick finds nothing due and sends nothing.
    await processDueAutomations();
    expect(email.outbox().filter((m) => m.to === lead.email)).toHaveLength(1);
  });

  it("waits, then acts", async () => {
    const ruleId = await saveRule({
      name: "Later",
      trigger: { type: "lead_created" },
      steps: [
        { id: "w", type: "wait", amount: 2, unit: "hours" },
        { id: "t", type: "create_task", title: `Call ${TAG}`, dueInHours: 0, priority: "high" },
      ],
    });
    const lead = await createLead();
    const now = new Date();

    await processDueAutomations(25, now);
    let [run] = await runsFor(ruleId);
    expect(run!.state).toBe("active");
    expect(run!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime() + HOUR);

    // Not yet.
    await processDueAutomations(25, new Date(now.getTime() + HOUR));
    expect(await getOwnerDb().db.select().from(tasks).where(eq(tasks.personId, lead.personId))).toHaveLength(0);

    await processDueAutomations(25, new Date(now.getTime() + 3 * HOUR));
    const created = await getOwnerDb().db.select().from(tasks).where(eq(tasks.personId, lead.personId));
    expect(created).toHaveLength(1);
    expect(created[0]!.priority).toBe("high");
    [run] = await runsFor(ruleId);
    expect(run!.state).toBe("completed");
  });

  it("stops at a condition that is no longer true", async () => {
    const ruleId = await saveRule({
      name: "Uncontacted",
      trigger: { type: "lead_created" },
      steps: [
        { id: "w", type: "wait", amount: 1, unit: "hours" },
        { id: "f", type: "filter", condition: "not_contacted" },
        { id: "t", type: "create_task", title: `Call ${TAG}`, dueInHours: 0 },
      ],
    });
    const lead = await createLead();
    const now = new Date();
    await processDueAutomations(25, now);

    // Someone called them in the meantime.
    await getOwnerDb().db.update(leads).set({ firstContactedAt: new Date() }).where(eq(leads.id, lead.id));
    await processDueAutomations(25, new Date(now.getTime() + 2 * HOUR));

    const [run] = await runsFor(ruleId);
    expect(run!.state).toBe("stopped");
    expect(run!.stopReason).toMatch(/Condition not met/);
    expect(await getOwnerDb().db.select().from(tasks).where(eq(tasks.personId, lead.personId))).toHaveLength(0);
  });

  it("stops when they book (PRD MSG-06)", async () => {
    const ruleId = await saveRule({
      name: "Nudge",
      trigger: { type: "lead_created" },
      stopWhen: ["booked"],
      steps: [{ id: "w", type: "wait", amount: 1, unit: "days" }, thankYou],
    });
    const lead = await createLead();
    const now = new Date();
    await processDueAutomations(25, now);

    const booked = await app.inject({
      method: "POST",
      url: "/appointments",
      headers: { cookie: adminCookie },
      payload: {
        personId: lead.personId,
        leadId: lead.id,
        staffUserId: practitionerId,
        startsAt: clinicLocalToUtc("2027-03-16", "10:00", "America/New_York").toISOString(),
        durationMinutes: 30,
        allowOutsideWorkingHours: true,
      },
    });
    expect(booked.statusCode).toBe(201);

    await processDueAutomations(25, new Date(now.getTime() + 2 * 24 * HOUR));
    const [run] = await runsFor(ruleId);
    expect(run!.state).toBe("stopped");
    expect(run!.stopReason).toBe("They booked an appointment");
    expect(email.outbox().filter((m) => m.to === lead.email)).toHaveLength(0);
  });

  it("waits out quiet hours instead of dropping the message", async () => {
    const ruleId = await saveRule({ name: "Quiet", trigger: { type: "lead_created" }, steps: [thankYou] });
    const lead = await createLead();
    // A window that always contains "now".
    await setQuietHours("00:00", "23:59");

    await processDueAutomations();
    const [run] = await runsFor(ruleId);
    expect(run!.state).toBe("active");
    expect(run!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(email.outbox().filter((m) => m.to === lead.email)).toHaveLength(0);
  });

  it("records a blocked send with its reason and carries on", async () => {
    const ruleId = await saveRule({
      name: "Promo",
      trigger: { type: "lead_created" },
      steps: [
        { ...thankYou, id: "p", purpose: "promotional" },
        { id: "t", type: "create_task", title: `Follow up ${TAG}`, dueInHours: 24 },
      ],
    });
    const lead = await createLead();
    await processDueAutomations();

    const [run] = await runsFor(ruleId);
    expect(run!.state).toBe("completed");
    expect(run!.history[0]!.outcome).toBe("blocked");
    expect(email.outbox().filter((m) => m.to === lead.email)).toHaveLength(0);
    // The task after it still happened.
    expect(await getOwnerDb().db.select().from(tasks).where(eq(tasks.personId, lead.personId))).toHaveLength(1);
  });

  it("pausing stops everyone in it", async () => {
    const ruleId = await saveRule({
      name: "Pause me",
      trigger: { type: "lead_created" },
      steps: [{ id: "w", type: "wait", amount: 1, unit: "days" }, thankYou],
    });
    await createLead();
    await processDueAutomations();

    const off = await app.inject({
      method: "POST",
      url: `/automations/${ruleId}/status`,
      headers: { cookie: adminCookie },
      payload: { status: "paused" },
    });
    expect(off.statusCode).toBe(200);
    const [run] = await runsFor(ruleId);
    expect(run!.state).toBe("stopped");
  });
});

describe("appointment reminders (PRD CAL-05)", () => {
  async function bookFor(personId: string, date: string, time: string) {
    const response = await app.inject({
      method: "POST",
      url: "/appointments",
      headers: { cookie: adminCookie },
      payload: {
        personId,
        staffUserId: practitionerId,
        startsAt: clinicLocalToUtc(date, time, "America/New_York").toISOString(),
        durationMinutes: 30,
        allowOutsideWorkingHours: true,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; startsAt: string };
  }

  it("schedules the reminder before the appointment, and cancelling stops it", async () => {
    const ruleId = await saveRule({
      name: "Reminder",
      trigger: { type: "appointment_upcoming", hoursBefore: 24 },
      steps: [thankYou],
    });
    const lead = await createLead();
    const visit = await bookFor(lead.personId, "2027-03-16", "10:00");

    let [run] = await runsFor(ruleId);
    expect(run!.nextRunAt!.toISOString()).toBe(new Date(new Date(visit.startsAt).getTime() - 24 * HOUR).toISOString());

    const cancel = await app.inject({
      method: "POST",
      url: `/appointments/${visit.id}/cancel`,
      headers: { cookie: adminCookie },
      payload: { reason: "Unwell" },
    });
    expect(cancel.statusCode).toBe(200);
    [run] = await runsFor(ruleId);
    expect(run!.state).toBe("stopped");

    // Even at the due time, nothing goes out.
    await processDueAutomations(25, new Date(new Date(visit.startsAt).getTime() - 23 * HOUR));
    expect(email.outbox().filter((m) => m.to === lead.email)).toHaveLength(0);
  });

  it("moves the reminder when the appointment moves", async () => {
    const ruleId = await saveRule({
      name: "Reminder",
      trigger: { type: "appointment_upcoming", hoursBefore: 24 },
      steps: [thankYou],
    });
    const lead = await createLead();
    const visit = await bookFor(lead.personId, "2027-03-16", "10:00");

    const moved = await app.inject({
      method: "POST",
      url: `/appointments/${visit.id}/reschedule`,
      headers: { cookie: adminCookie },
      payload: {
        startsAt: clinicLocalToUtc("2027-03-18", "15:00", "America/New_York").toISOString(),
        reason: "Client asked",
        allowOutsideWorkingHours: true,
      },
    });
    expect(moved.statusCode).toBe(200);

    const runs = await runsFor(ruleId);
    const old = runs.find((r) => r.appointmentId === visit.id)!;
    const fresh = runs.find((r) => r.appointmentId === moved.json().id)!;
    expect(old.state).toBe("stopped");
    expect(fresh.state).toBe("active");
    expect(fresh.nextRunAt!.toISOString()).toBe(
      new Date(new Date(moved.json().startsAt).getTime() - 24 * HOUR).toISOString(),
    );
  });
});

describe("dry run and access", () => {
  it("previews each step against a real lead without sending", async () => {
    const lead = await createLead();
    const response = await app.inject({
      method: "POST",
      url: "/automations/test",
      headers: { cookie: adminCookie },
      payload: {
        name: `Preview ${TAG}`,
        trigger: { type: "lead_created" },
        steps: [{ id: "w", type: "wait", amount: 1, unit: "hours" }, thankYou],
        leadId: lead.id,
      },
    });
    expect(response.statusCode).toBe(200);
    const lines = response.json().lines as { outcome: string; preview: { body: string } | null }[];
    expect(lines[0]!.outcome).toBe("info");
    expect(lines[1]!.outcome).toBe("would_run");
    expect(lines[1]!.preview!.body).toContain("Hi Dana");
    expect(email.outbox()).toHaveLength(0);
  });

  it("is admin-only", async () => {
    const frontDesk = await authenticate(app, SEED.frontDesk);
    const response = await app.inject({ method: "GET", url: "/automations", headers: { cookie: frontDesk } });
    expect(response.statusCode).toBe(403);
  });

  it("keeps each clinic's automations to itself", async () => {
    const ruleId = await saveRule({ name: "Mine", trigger: { type: "lead_created" }, steps: [thankYou] }, false);
    const other = await authenticate(app, SEED.otherClinicAdmin);
    const response = await app.inject({ method: "GET", url: `/automations/${ruleId}`, headers: { cookie: other } });
    expect(response.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/automations", headers: { cookie: other } });
    expect((list.json().items as { id: string }[]).some((r) => r.id === ruleId)).toBe(false);
  });
});
