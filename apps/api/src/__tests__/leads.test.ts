/**
 * Lead pipeline, timeline and tasks (PRD LEAD-01 … LEAD-06).
 *
 * Requires a migrated and seeded database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";

const { people, leads, tasks, activities, leadStageEvents } = schema;

let app: FastifyInstance;
let adminCookie: string;
let stages: Record<string, string>;

const TAG = "leadtest";

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  adminCookie = await authenticate(app, SEED.admin);

  const response = await app.inject({
    method: "GET",
    url: "/pipeline/stages",
    headers: { cookie: adminCookie },
  });
  stages = Object.fromEntries(
    (response.json().items as { id: string; category: string }[]).map((s) => [s.category, s.id]),
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
  if (leadIds.length > 0) await db.delete(leads).where(inArray(leads.id, leadIds));
  await db.delete(people).where(inArray(people.id, ids));
}

async function createLead(
  overrides: Record<string, unknown> = {},
  cookie = adminCookie,
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "POST",
    url: "/leads",
    headers: { cookie },
    payload: {
      person: { firstName: `Walk ${TAG}`, phone: randomPhone(), allowDuplicate: true },
      source: "walk_in",
      serviceInterest: "Consultation",
      ...overrides,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createLead failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

let phoneCounter = 1000;
function randomPhone(): string {
  phoneCounter += 1;
  return `305-555-${String(phoneCounter).padStart(4, "0")}`;
}

function moveStage(leadId: string, category: string, reason?: string, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: `/leads/${leadId}/stage`,
    headers: { cookie },
    payload: { stageId: stages[category], ...(reason ? { reason } : {}) },
  });
}

describe("walk-in intake (PRD ID-03, J2)", () => {
  it("creates the person and the lead in one request, starting in New", async () => {
    const lead = await createLead();
    expect(lead.stageCategory).toBe("new");
    expect(lead.source).toBe("walk_in");
    expect(lead.personName).toContain(TAG);
    // No owner means it lands in the unassigned queue (PRD LEAD-03).
    expect(lead.ownerUserId).toBeNull();
  });

  it("attaches a second inquiry to the same person rather than duplicating them", async () => {
    const first = await createLead();
    const personId = first.personId as string;

    const second = await app.inject({
      method: "POST",
      url: "/leads",
      headers: { cookie: adminCookie },
      payload: { personId, source: "phone", serviceInterest: "Follow-up consultation" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().personId).toBe(personId);

    // One person, two inquiries — the BRD 2 assumption made concrete.
    const theirLeads = await app.inject({
      method: "GET",
      url: `/people/${personId}/leads`,
      headers: { cookie: adminCookie },
    });
    expect(theirLeads.json().items).toHaveLength(2);
  });

  it("refuses to create a lead with neither a person nor person details", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/leads",
      headers: { cookie: adminCookie },
      payload: { source: "walk_in" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("writes an opening stage event and a timeline entry", async () => {
    const lead = await createLead();
    const timeline = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}/timeline`,
      headers: { cookie: adminCookie },
    });
    const types = (timeline.json().items as { type: string }[]).map((a) => a.type);
    expect(types).toContain("source_submission");
  });
});

describe("stage transitions (PRD LEAD-02)", () => {
  it("records actor, time and the from/to stage", async () => {
    const lead = await createLead();
    const moved = await moveStage(lead.id as string, "attempting_contact");
    expect(moved.statusCode).toBe(200);
    expect(moved.json().stageCategory).toBe("attempting_contact");

    const { db } = getOwnerDb();
    const events = await db
      .select()
      .from(leadStageEvents)
      .where(eq(leadStageEvents.leadId, lead.id as string));
    // The opening event plus this transition.
    expect(events.length).toBe(2);
    expect(events.at(-1)!.actorUserId).not.toBeNull();
  });

  it("requires a reason for Lost and refuses without one", async () => {
    const lead = await createLead();

    const withoutReason = await moveStage(lead.id as string, "lost");
    expect(withoutReason.statusCode).toBe(400);
    expect(JSON.stringify(withoutReason.json())).toMatch(/reason/i);

    const withReason = await moveStage(lead.id as string, "lost", "Went to another clinic");
    expect(withReason.statusCode).toBe(200);
    expect(withReason.json().lossReason).toBe("Went to another clinic");
    expect(withReason.json().isClosed).toBe(true);
    expect(withReason.json().closedAt).not.toBeNull();
  });

  it("requires a reason for Unqualified too", async () => {
    const lead = await createLead();
    expect((await moveStage(lead.id as string, "unqualified")).statusCode).toBe(400);
    expect((await moveStage(lead.id as string, "unqualified", "Wrong number")).statusCode).toBe(200);
  });

  it("does not require a reason for ordinary forward progress", async () => {
    const lead = await createLead();
    for (const category of ["attempting_contact", "connected", "qualified"]) {
      const response = await moveStage(lead.id as string, category);
      expect(response.statusCode, category).toBe(200);
    }
  });

  it("stamps each milestone as it is first reached", async () => {
    const lead = await createLead();
    const id = lead.id as string;

    await moveStage(id, "qualified");
    const qualified = (await moveStage(id, "consultation_booked")).json();
    expect(qualified.qualifiedAt).not.toBeNull();
    expect(qualified.bookedAt).not.toBeNull();
    expect(qualified.attendedAt).toBeNull();

    await moveStage(id, "consultation_attended");
    const converted = (await moveStage(id, "converted")).json();
    expect(converted.attendedAt).not.toBeNull();
    expect(converted.convertedAt).not.toBeNull();
    expect(converted.isClosed).toBe(true);
  });

  it("never re-stamps a milestone the lead reaches twice", async () => {
    const lead = await createLead();
    const id = lead.id as string;

    const first = (await moveStage(id, "qualified")).json();
    const originalQualifiedAt = first.qualifiedAt as string;
    expect(originalQualifiedAt).not.toBeNull();

    // Bounce back and forward again.
    await moveStage(id, "connected");
    const second = (await moveStage(id, "qualified")).json();

    // The first time it genuinely happened is the truthful event time, and
    // re-stamping would make conversion feedback report it twice (PRD FB-05).
    expect(second.qualifiedAt).toBe(originalQualifiedAt);
  });

  it("clears the closure when a closed lead is reopened, keeping its milestones", async () => {
    const lead = await createLead();
    const id = lead.id as string;

    await moveStage(id, "qualified");
    const lost = (await moveStage(id, "lost", "Changed their mind")).json();
    expect(lost.closedAt).not.toBeNull();

    const reopened = (await moveStage(id, "connected")).json();
    expect(reopened.closedAt).toBeNull();
    expect(reopened.lossReason).toBeNull();
    // The milestone stays: it records what actually happened.
    expect(reopened.qualifiedAt).toBe(lost.qualifiedAt);
  });

  it("rejects a stage belonging to another clinic", async () => {
    const lead = await createLead();
    const otherCookie = await authenticate(app, SEED.otherClinicAdmin);
    const otherStages = await app.inject({
      method: "GET",
      url: "/pipeline/stages",
      headers: { cookie: otherCookie },
    });
    const foreignStageId = (otherStages.json().items as { id: string; category: string }[]).find(
      (s) => s.category === "qualified",
    )!.id;

    const response = await app.inject({
      method: "POST",
      url: `/leads/${lead.id}/stage`,
      headers: { cookie: adminCookie },
      payload: { stageId: foreignStageId },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("assignment and the unassigned queue (PRD LEAD-03)", () => {
  it("assigns and unassigns, recording both on the timeline", async () => {
    const lead = await createLead();
    const staff = await app.inject({ method: "GET", url: "/users", headers: { cookie: adminCookie } });
    const frontDesk = (staff.json().items as { id: string; email: string }[]).find(
      (u) => u.email === SEED.frontDesk,
    )!;

    const assigned = await app.inject({
      method: "POST",
      url: `/leads/${lead.id}/assign`,
      headers: { cookie: adminCookie },
      payload: { ownerUserId: frontDesk.id },
    });
    expect(assigned.json().ownerUserId).toBe(frontDesk.id);
    expect(assigned.json().ownerName).toBe("Priya Raman");

    const returned = await app.inject({
      method: "POST",
      url: `/leads/${lead.id}/assign`,
      headers: { cookie: adminCookie },
      payload: { ownerUserId: null },
    });
    expect(returned.json().ownerUserId).toBeNull();

    const timeline = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}/timeline`,
      headers: { cookie: adminCookie },
    });
    const assignmentEntries = (timeline.json().items as { type: string }[]).filter(
      (a) => a.type === "assignment_change",
    );
    expect(assignmentEntries).toHaveLength(2);
  });

  it("refuses to assign to someone from another clinic", async () => {
    const lead = await createLead();
    const { db } = getOwnerDb();
    const foreign = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, SEED.otherClinicAdmin));

    const response = await app.inject({
      method: "POST",
      url: `/leads/${lead.id}/assign`,
      headers: { cookie: adminCookie },
      payload: { ownerUserId: foreign[0]!.id },
    });
    expect(response.statusCode).toBe(400);
  });

  it("filters the list to the unassigned queue", async () => {
    const unassigned = await createLead();
    const staff = await app.inject({ method: "GET", url: "/users", headers: { cookie: adminCookie } });
    const frontDeskId = (staff.json().items as { id: string; email: string }[]).find(
      (u) => u.email === SEED.frontDesk,
    )!.id;
    const assigned = await createLead({ ownerUserId: frontDeskId });

    const response = await app.inject({
      method: "GET",
      url: "/leads?unassigned=true",
      headers: { cookie: adminCookie },
    });
    const ids = (response.json().items as { id: string }[]).map((l) => l.id);
    expect(ids).toContain(unassigned.id);
    expect(ids).not.toContain(assigned.id);
  });
});

describe("lead visibility by role (PRD 2)", () => {
  it("shows a practitioner only their own leads plus the unassigned queue", async () => {
    const staff = await app.inject({ method: "GET", url: "/users", headers: { cookie: adminCookie } });
    const list = staff.json().items as { id: string; email: string }[];
    const practitionerId = list.find((u) => u.email === SEED.practitioner)!.id;
    const frontDeskId = list.find((u) => u.email === SEED.frontDesk)!.id;

    const mine = await createLead({ ownerUserId: practitionerId });
    const someoneElses = await createLead({ ownerUserId: frontDeskId });
    const queued = await createLead();

    const practitionerCookie = await authenticate(app, SEED.practitioner);
    const response = await app.inject({
      method: "GET",
      url: "/leads",
      headers: { cookie: practitionerCookie },
    });
    const ids = (response.json().items as { id: string }[]).map((l) => l.id);

    expect(ids).toContain(mine.id);
    expect(ids).toContain(queued.id);
    expect(ids).not.toContain(someoneElses.id);

    // The count must agree with the rows, or the UI shows a total it cannot list.
    expect(response.json().totalCount).toBe(ids.length);
  });

  it("refuses a practitioner direct access to another person's lead", async () => {
    const staff = await app.inject({ method: "GET", url: "/users", headers: { cookie: adminCookie } });
    const frontDeskId = (staff.json().items as { id: string; email: string }[]).find(
      (u) => u.email === SEED.frontDesk,
    )!.id;
    const someoneElses = await createLead({ ownerUserId: frontDeskId });

    const practitionerCookie = await authenticate(app, SEED.practitioner);
    const response = await app.inject({
      method: "GET",
      url: `/leads/${someoneElses.id}`,
      headers: { cookie: practitionerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not leak leads across clinics", async () => {
    const mine = await createLead();
    const otherCookie = await authenticate(app, SEED.otherClinicAdmin);

    const list = await app.inject({ method: "GET", url: "/leads", headers: { cookie: otherCookie } });
    expect((list.json().items as { id: string }[]).map((l) => l.id)).not.toContain(mine.id);

    const direct = await app.inject({
      method: "GET",
      url: `/leads/${mine.id}`,
      headers: { cookie: otherCookie },
    });
    expect(direct.statusCode).toBe(404);
  });
});

describe("contact attempts (PRD LEAD-06)", () => {
  it("logs an attempt and stamps first contact only once", async () => {
    const lead = await createLead();
    const id = lead.id as string;

    const noAnswer = await app.inject({
      method: "POST",
      url: `/leads/${id}/contact-attempts`,
      headers: { cookie: adminCookie },
      payload: { outcome: "no_answer", channel: "phone", note: "Rang out" },
    });
    expect(noAnswer.statusCode).toBe(201);
    expect(noAnswer.json().firstContactedAt).toBeNull();

    const connected = await app.inject({
      method: "POST",
      url: `/leads/${id}/contact-attempts`,
      headers: { cookie: adminCookie },
      payload: { outcome: "connected", channel: "phone" },
    });
    const firstContactedAt = connected.json().firstContactedAt as string;
    expect(firstContactedAt).not.toBeNull();

    const again = await app.inject({
      method: "POST",
      url: `/leads/${id}/contact-attempts`,
      headers: { cookie: adminCookie },
      payload: { outcome: "connected", channel: "phone" },
    });
    // Response-time reporting needs the first contact, not the latest.
    expect(again.json().firstContactedAt).toBe(firstContactedAt);
  });

  it("can advance the stage in the same action", async () => {
    const lead = await createLead();
    const response = await app.inject({
      method: "POST",
      url: `/leads/${lead.id}/contact-attempts`,
      headers: { cookie: adminCookie },
      payload: { outcome: "connected", stageId: stages.connected },
    });
    expect(response.json().stageCategory).toBe("connected");
  });

  it("keeps an inquiry note separate from the person's General Notes", async () => {
    const lead = await createLead();
    await app.inject({
      method: "POST",
      url: `/leads/${lead.id}/notes`,
      headers: { cookie: adminCookie },
      payload: { body: "Mentioned a budget of $500 for this enquiry" },
    });

    const timeline = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}/timeline`,
      headers: { cookie: adminCookie },
    });
    expect((timeline.json().items as { type: string }[]).some((a) => a.type === "note")).toBe(true);

    // It must NOT appear as a person-level General Note (PRD LEAD-06).
    const generalNotes = await app.inject({
      method: "GET",
      url: `/people/${lead.personId}/notes`,
      headers: { cookie: adminCookie },
    });
    expect(generalNotes.json().items).toHaveLength(0);
  });
});

describe("tasks (PRD LEAD-05)", () => {
  it("requires an outcome to complete, and records it", async () => {
    const lead = await createLead();
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: `Call back ${TAG}`,
        leadId: lead.id,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;

    const withoutOutcome = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/complete`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(withoutOutcome.statusCode).toBe(400);

    const completed = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/complete`,
      headers: { cookie: adminCookie },
      payload: { outcome: "connected", outcomeNote: "Booked for Thursday" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().outcome).toBe("connected");
    expect(completed.json().completedAt).not.toBeNull();
  });

  it("refuses to complete the same task twice", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: adminCookie },
      payload: { title: `Once ${TAG}`, dueAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const taskId = created.json().id as string;
    const complete = () =>
      app.inject({
        method: "POST",
        url: `/tasks/${taskId}/complete`,
        headers: { cookie: adminCookie },
        payload: { outcome: "other" },
      });
    expect((await complete()).statusCode).toBe(200);
    expect((await complete()).statusCode).toBe(400);
  });

  it("requires a future time to snooze", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: adminCookie },
      payload: { title: `Snooze ${TAG}`, dueAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const taskId = created.json().id as string;

    const backwards = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/snooze`,
      headers: { cookie: adminCookie },
      payload: { dueAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(backwards.statusCode).toBe(400);

    const forwards = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/snooze`,
      headers: { cookie: adminCookie },
      payload: { dueAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(forwards.statusCode).toBe(200);
    expect(forwards.json().status).toBe("open");
  });

  it("lists overdue work separately", async () => {
    const lead = await createLead();
    await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: `Overdue ${TAG}`,
        leadId: lead.id,
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });
    await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: `Future ${TAG}`,
        leadId: lead.id,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });

    const overdue = await app.inject({
      method: "GET",
      url: "/tasks?dueView=overdue",
      headers: { cookie: adminCookie },
    });
    const titles = (overdue.json().items as { title: string }[]).map((t) => t.title);
    expect(titles).toContain(`Overdue ${TAG}`);
    expect(titles).not.toContain(`Future ${TAG}`);
  });

  it("flags a task whose lead has been closed", async () => {
    const lead = await createLead();
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: `Orphan ${TAG}`,
        leadId: lead.id,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(created.json().leadClosed).toBe(false);

    await moveStage(lead.id as string, "lost", "No longer interested");

    const listed = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}/tasks`,
      headers: { cookie: adminCookie },
    });
    // Visible as belonging to a closed lead rather than lingering silently.
    expect((listed.json().items as { leadClosed: boolean }[])[0]!.leadClosed).toBe(true);
  });
});

describe("filters and counts (PRD LEAD-01)", () => {
  it("stage counts agree with the filtered list", async () => {
    const a = await createLead();
    const b = await createLead();
    await moveStage(a.id as string, "qualified");
    await moveStage(b.id as string, "qualified");

    const response = await app.inject({
      method: "GET",
      url: `/leads?stageCategory=qualified&limit=100`,
      headers: { cookie: adminCookie },
    });
    const items = response.json().items as { id: string; stageId: string }[];
    const counts = response.json().stageCounts as Record<string, number>;

    const qualifiedStageId = stages.qualified!;
    expect(counts[qualifiedStageId]).toBe(items.length);
    expect(items.every((l) => l.stageId === qualifiedStageId)).toBe(true);
  });

  it("excludes closed leads when asked", async () => {
    const open = await createLead();
    const closed = await createLead();
    await moveStage(closed.id as string, "lost", "Not interested");

    const response = await app.inject({
      method: "GET",
      url: "/leads?includeClosed=false&limit=100",
      headers: { cookie: adminCookie },
    });
    const ids = (response.json().items as { id: string }[]).map((l) => l.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(closed.id);
  });

  it("filters by source", async () => {
    const walkIn = await createLead({ source: "walk_in" });
    const phone = await createLead({ source: "phone" });

    const response = await app.inject({
      method: "GET",
      url: "/leads?source=phone&limit=100",
      headers: { cookie: adminCookie },
    });
    const ids = (response.json().items as { id: string }[]).map((l) => l.id);
    expect(ids).toContain(phone.id);
    expect(ids).not.toContain(walkIn.id);
  });
});
