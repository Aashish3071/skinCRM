/** In-app notifications (D-77). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockEmailConnector, MockWhatsAppConnector, resetConnectors, setConnectors } from "@skincrm/connectors";
import { SEED, authenticate, createTestApp, resetAuthState, letters } from "./helpers";
import { processTimedNotifications } from "../notifications/service";

const { people, leads, leadStageEvents, activities, notifications, users, appointments, messages, conversations, consentRecords, sourceSubmissions } = schema;
const TAG = "notiftest";
let app: FastifyInstance;
let admin: string;
let frontDesk: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  frontDesk = await authenticate(app, SEED.frontDesk);
  const { db } = getOwnerDb();
  for (const key of ["admin", "frontDesk", "frontDesk2", "practitioner"] as const) {
    ids[key] = (await db.select({ id: users.id }).from(users).where(eq(users.email, SEED[key])))[0]!.id;
  }
  setConnectors({ email: new MockEmailConnector(), whatsapp: new MockWhatsAppConnector() });
});
afterAll(async () => {
  await cleanup();
  await getOwnerDb().db.update(users).set({ mutedNotifications: [] }).where(inArray(users.id, Object.values(ids)));
  resetConnectors();
  await app.close();
  await closeAllConnections();
});
beforeEach(cleanup);

async function cleanup() {
  const { db } = getOwnerDb();
  const pids = (await db.select({ id: people.id }).from(people).where(or(like(people.displayName, `%${TAG}%`), like(people.phoneRaw, "+13055577%")))).map((r) => r.id);
  await db.delete(notifications).where(or(like(notifications.title, `%${TAG}%`), like(notifications.dedupeKey, "appt:%"), like(notifications.dedupeKey, "wa:%"))!);
  if (!pids.length) return;
  await db.delete(appointments).where(inArray(appointments.personId, pids));
  await db.delete(messages).where(inArray(messages.personId, pids));
  await db.delete(conversations).where(inArray(conversations.personId, pids));
  await db.delete(consentRecords).where(inArray(consentRecords.personId, pids));
  const lids = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, pids))).map((r) => r.id);
  if (lids.length) {
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, lids));
    await db.delete(leads).where(inArray(leads.id, lids));
  }
  await db.delete(activities).where(inArray(activities.personId, pids));
  await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.personId, pids));
  await db.delete(people).where(inArray(people.id, pids));
}

let n = 0;
async function lead(cookie = frontDesk) {
  n += 1;
  const r = await app.inject({ method: "POST", url: "/leads", headers: { cookie }, payload: { person: { firstName: `N${letters(n)} ${TAG}`, phone: `305-555-${5500 + n}`, allowDuplicate: true }, source: "walk_in", ownerUserId: null } });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; personId: string };
}
const mine = (userId: string) => getOwnerDb().db.select().from(notifications).where(eq(notifications.userId, userId));

describe("who gets told", () => {
  it("a new unowned lead notifies the people who can pick it up — not whoever added it", async () => {
    const l = await lead();
    const forAdmin = (await mine(ids.admin!)).filter((x) => x.link === `/leads/${l.id}`);
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0]!.type).toBe("lead_new");
    expect((await mine(ids.frontDesk!)).filter((x) => x.link === `/leads/${l.id}`)).toHaveLength(0);
  });

  it("assigning a lead notifies the new owner", async () => {
    const l = await lead(admin);
    await app.inject({ method: "POST", url: `/leads/${l.id}/assign`, headers: { cookie: admin }, payload: { ownerUserId: ids.frontDesk2 } });
    const got = (await mine(ids.frontDesk2!)).filter((x) => x.link === `/leads/${l.id}`);
    expect(got.map((x) => x.type)).toContain("lead_assigned");
  });

  it("respects a muted type", async () => {
    await app.inject({ method: "PUT", url: "/me/notification-settings", headers: { cookie: admin }, payload: { muted: ["lead_new"] } });
    const l = await lead();
    expect((await mine(ids.admin!)).filter((x) => x.link === `/leads/${l.id}`)).toHaveLength(0);
    await app.inject({ method: "PUT", url: "/me/notification-settings", headers: { cookie: admin }, payload: { muted: [] } });
  });

  it("an hour before an appointment, tells the person seeing them — once", async () => {
    const l = await lead(admin);
    const start = new Date(Date.now() + 30 * 60_000);
    const r = await app.inject({ method: "POST", url: "/appointments", headers: { cookie: admin },
      payload: { personId: l.personId, staffUserId: ids.practitioner, startsAt: start.toISOString(), durationMinutes: 30, allowOutsideWorkingHours: true } });
    expect(r.statusCode).toBe(201);
    await processTimedNotifications();
    await processTimedNotifications();
    const got = (await mine(ids.practitioner!)).filter((x) => x.dedupeKey === `appt:${r.json().id}:soon`);
    expect(got).toHaveLength(1);
    expect(got[0]!.title).toMatch(/in \d+ min/);
  });

  it("repeat WhatsApp messages bump one notification rather than piling up", async () => {
    const sim = (body: string) => app.inject({ method: "POST", url: "/inbox/simulate", headers: { cookie: admin }, payload: { phone: "+1 305 557 7001", name: `Wa ${TAG}`, body } });
    const first = (await sim("Hello")).json().conversationId;
    await app.inject({ method: "POST", url: "/notifications/read-all", headers: { cookie: frontDesk } });
    await sim("Are you there?");
    const got = (await mine(ids.frontDesk!)).filter((x) => x.dedupeKey === `wa:${first}`);
    expect(got).toHaveLength(1);
    expect(got[0]!.readAt).toBeNull();
    expect(got[0]!.body).toBe("Are you there?");
  });
});

describe("reading", () => {
  it("lists only your own, counts unread, and marks read", async () => {
    await lead();
    const list = await app.inject({ method: "GET", url: "/notifications", headers: { cookie: admin } });
    expect(list.json().unreadCount).toBeGreaterThan(0);
    const first = list.json().items[0];
    // Someone else can't mark it.
    await app.inject({ method: "POST", url: `/notifications/${first.id}/read`, headers: { cookie: frontDesk } });
    expect((await getOwnerDb().db.select().from(notifications).where(eq(notifications.id, first.id)))[0]!.readAt).toBeNull();
    await app.inject({ method: "POST", url: "/notifications/read-all", headers: { cookie: admin } });
    const after = await app.inject({ method: "GET", url: "/notifications", headers: { cookie: admin } });
    expect(after.json().unreadCount).toBe(0);
  });
});
