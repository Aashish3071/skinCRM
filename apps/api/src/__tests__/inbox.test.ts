/**
 * Shared inbox, Notes/Activity feeds and public unsubscribe
 * (PRD WA-01…06, MSG-04, D-63).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockEmailConnector, MockWhatsAppConnector, resetConnectors, setConnectors } from "@skincrm/connectors";
import { resetEnvCache } from "@skincrm/config";
import { createUnsubscribeToken } from "@skincrm/security";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";

const { people, leads, leadStageEvents, activities, messages, conversations, consentRecords, clinics, sourceSubmissions, generalNotes } = schema;
const TAG = "inboxtest";

let app: FastifyInstance;
let admin: string;
let whatsapp: MockWhatsAppConnector;
let counter = 0;

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
});
afterAll(async () => {
  await cleanup();
  await getOwnerDb().db.update(clinics).set({ quietHoursStart: "21:00", quietHoursEnd: "08:00" });
  resetConnectors();
  await app.close();
  await closeAllConnections();
});
beforeEach(async () => {
  await cleanup();
  whatsapp = new MockWhatsAppConnector();
  setConnectors({ email: new MockEmailConnector(), whatsapp });
  process.env.OUTBOUND_SENDING_ENABLED = "true";
  resetEnvCache();
  await getOwnerDb().db.update(clinics).set({ quietHoursStart: "00:00", quietHoursEnd: "00:00" });
});
afterEach(() => {
  delete process.env.OUTBOUND_SENDING_ENABLED;
  resetEnvCache();
});

async function cleanup() {
  const { db } = getOwnerDb();
  const rows = await db.select({ id: people.id }).from(people).where(or(like(people.displayName, `%${TAG}%`), like(people.phoneRaw, "+1305555%")));
  const ids = rows.map((r) => r.id).filter(Boolean);
  if (!ids.length) return;
  await db.delete(messages).where(inArray(messages.personId, ids));
  await db.delete(conversations).where(inArray(conversations.personId, ids));
  await db.delete(consentRecords).where(inArray(consentRecords.personId, ids));
  await db.delete(generalNotes).where(inArray(generalNotes.personId, ids));
  const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
  if (leadIds.length) {
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }
  await db.delete(activities).where(inArray(activities.personId, ids));
  await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.personId, ids));
  await db.delete(people).where(inArray(people.id, ids));
}

function phone() {
  counter += 1;
  return `+1305555${String(8000 + counter).padStart(4, "0")}`;
}

const simulate = (payload: Record<string, unknown>, cookie = admin) =>
  app.inject({ method: "POST", url: "/inbox/simulate", headers: { cookie }, payload });

describe("inbound WhatsApp (PRD WA-01, WA-02)", () => {
  it("turns a stranger's first message into a person, a lead and an unread thread", async () => {
    const number = phone();
    const res = await simulate({ phone: number, name: `Nia ${TAG}`, body: "Do you do laser?" });
    expect(res.statusCode).toBe(200);
    const { conversationId } = res.json();

    const list = await app.inject({ method: "GET", url: "/conversations?view=unassigned", headers: { cookie: admin } });
    const row = (list.json().items as { id: string; unreadCount: number; personName: string; windowOpenUntil: string | null }[]).find((c) => c.id === conversationId)!;
    expect(row.unreadCount).toBe(1);
    expect(row.personName).toContain("Nia");
    expect(row.windowOpenUntil).not.toBeNull();

    const person = (await getOwnerDb().db.select().from(people).where(eq(people.phoneE164, number)))[0]!;
    const lead = await getOwnerDb().db.select().from(leads).where(eq(leads.personId, person.id));
    expect(lead).toHaveLength(1);
    expect(lead[0]!.source).toBe("whatsapp_organic");
  });

  it("puts a known patient's messages in one thread, without new leads", async () => {
    const number = phone();
    const first = (await simulate({ phone: number, name: `Omar ${TAG}`, body: "Hi" })).json().conversationId;
    const second = (await simulate({ phone: number, body: "Are you there?" })).json().conversationId;
    expect(second).toBe(first);
    const person = (await getOwnerDb().db.select().from(people).where(eq(people.phoneE164, number)))[0]!;
    expect(await getOwnerDb().db.select().from(leads).where(eq(leads.personId, person.id))).toHaveLength(1);
    const thread = await app.inject({ method: "GET", url: `/conversations/${first}`, headers: { cookie: admin } });
    expect(thread.json().items.filter((i: { kind: string }) => i.kind === "message")).toHaveLength(2);
  });
});

describe("replying (PRD WA-03, WA-05, WA-06)", () => {
  it("sends inside the 24-hour window, claims the thread and clears unread", async () => {
    const id = (await simulate({ phone: phone(), name: `Ana ${TAG}`, body: "Price?" })).json().conversationId;
    const reply = await app.inject({ method: "POST", url: `/conversations/${id}/reply`, headers: { cookie: admin }, payload: { body: "Hi Ana, it starts at $150." } });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().state).toBe("sent");
    expect(whatsapp.outbox()).toHaveLength(1);

    const convo = (await getOwnerDb().db.select().from(conversations).where(eq(conversations.id, id)))[0]!;
    expect(convo.assignedUserId).not.toBeNull();
    expect(convo.unreadCount).toBe(0);
    expect(convo.lastDirection).toBe("outbound");
  });

  it("blocks free text once the window has closed, and shows why in the thread", async () => {
    const id = (await simulate({ phone: phone(), name: `Bo ${TAG}`, body: "Hello" })).json().conversationId;
    await getOwnerDb().db.update(messages).set({ createdAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(messages.conversationId, id));
    const reply = await app.inject({ method: "POST", url: `/conversations/${id}/reply`, headers: { cookie: admin }, payload: { body: "Still interested?" } });
    expect(reply.json().state).toBe("suppressed");
    expect(reply.json().suppressionReason).toBe("outside_service_window");
    const thread = (await app.inject({ method: "GET", url: `/conversations/${id}`, headers: { cookie: admin } })).json();
    expect(thread.items.at(-1).suppressionReason).toBe("outside_service_window");
  });

  it("refuses a reply while a colleague is typing one", async () => {
    const id = (await simulate({ phone: phone(), name: `Cy ${TAG}`, body: "Hello" })).json().conversationId;
    const other = await authenticate(app, SEED.frontDesk);
    expect((await app.inject({ method: "POST", url: `/conversations/${id}/typing`, headers: { cookie: other } })).statusCode).toBe(204);
    const reply = await app.inject({ method: "POST", url: `/conversations/${id}/reply`, headers: { cookie: admin }, payload: { body: "Hi" } });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.message).toMatch(/is replying/);
  });

  it("keeps internal notes out of what is sent", async () => {
    const id = (await simulate({ phone: phone(), name: `Di ${TAG}`, body: "Hello" })).json().conversationId;
    const note = await app.inject({ method: "POST", url: `/conversations/${id}/notes`, headers: { cookie: admin }, payload: { body: "VIP, be quick" } });
    expect(note.statusCode).toBe(201);
    expect(whatsapp.outbox()).toHaveLength(0);
    const thread = (await app.inject({ method: "GET", url: `/conversations/${id}`, headers: { cookie: admin } })).json();
    expect(thread.items.some((i: { kind: string }) => i.kind === "note")).toBe(true);
  });

  it("is invisible to another clinic", async () => {
    const id = (await simulate({ phone: phone(), name: `Ed ${TAG}`, body: "Hello" })).json().conversationId;
    const other = await authenticate(app, SEED.otherClinicAdmin);
    expect((await app.inject({ method: "GET", url: `/conversations/${id}`, headers: { cookie: other } })).statusCode).toBe(404);
  });
});

describe("Notes and Activity feeds", () => {
  it("lists notes across patients and searches their text", async () => {
    const person = (await app.inject({ method: "POST", url: "/people", headers: { cookie: admin }, payload: { firstName: `Fay ${TAG}`, phone: phone(), allowDuplicate: true } })).json();
    await app.inject({ method: "POST", url: `/people/${person.id}/notes`, headers: { cookie: admin }, payload: { body: "Allergic to lidocaine", pinned: true } });
    const found = await app.inject({ method: "GET", url: "/notes?search=lidocaine", headers: { cookie: admin } });
    expect(found.json().items.some((n: { personId: string; isMine: boolean }) => n.personId === person.id && n.isMine)).toBe(true);
    const pinned = await app.inject({ method: "GET", url: "/notes?pinned=true", headers: { cookie: admin } });
    expect(pinned.json().items.every((n: { pinned: boolean }) => n.pinned)).toBe(true);
  });

  it("filters activity to one patient and to one kind", async () => {
    await simulate({ phone: phone(), name: `Gil ${TAG}`, body: "Hello" });
    const person = (await getOwnerDb().db.select().from(people).where(like(people.displayName, `Gil ${TAG}%`)))[0]!;
    const feed = await app.inject({ method: "GET", url: `/activities?personId=${person.id}&group=messages`, headers: { cookie: admin } });
    const items = feed.json().items as { type: string; personId: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.personId === person.id && i.type.startsWith("whatsapp"))).toBe(true);
  });
});

describe("public unsubscribe (MSG-04)", () => {
  it("withdraws marketing consent only, and is idempotent", async () => {
    const person = (await app.inject({ method: "POST", url: "/people", headers: { cookie: admin }, payload: { firstName: `Hal ${TAG}`, email: `hal.${TAG}@example.test`, allowDuplicate: true } })).json();
    const clinicId = (await getOwnerDb().db.select({ c: people.clinicId }).from(people).where(eq(people.id, person.id)))[0]!.c;
    const token = createUnsubscribeToken({ clinicId, personId: person.id, channel: "email" });

    const info = await app.inject({ method: "GET", url: `/public/unsubscribe/${token}` });
    expect(info.statusCode).toBe(200);
    expect(info.json().unsubscribed).toBe(false);
    expect(JSON.stringify(info.json())).not.toContain("Hal");

    expect((await app.inject({ method: "POST", url: `/public/unsubscribe/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/public/unsubscribe/${token}` })).statusCode).toBe(200);
    const rows = await getOwnerDb().db.select().from(consentRecords).where(eq(consentRecords.personId, person.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe("promotional");
    expect(rows[0]!.status).toBe("withdrawn");
  });

  it("rejects a tampered token", async () => {
    expect((await app.inject({ method: "GET", url: "/public/unsubscribe/abc.def-tampered-token" })).statusCode).toBe(404);
  });
});

describe("Qualified means booked (D-63)", () => {
  it("stamps the qualified milestone when a lead reaches Qualified", async () => {
    const lead = (await app.inject({ method: "POST", url: "/leads", headers: { cookie: admin }, payload: { person: { firstName: `Ivy ${TAG}`, phone: phone(), allowDuplicate: true }, source: "walk_in" } })).json();
    const stages = (await app.inject({ method: "GET", url: "/pipeline/stages", headers: { cookie: admin } })).json().items as { id: string; category: string; name: string }[];
    const booked = stages.find((s) => s.category === "consultation_booked")!;
    expect(booked.name).toBe("Qualified");
    const moved = (await app.inject({ method: "POST", url: `/leads/${lead.id}/stage`, headers: { cookie: admin }, payload: { stageId: booked.id } })).json();
    expect(moved.qualifiedAt).not.toBeNull();
    expect(moved.bookedAt).not.toBeNull();
  });
});
