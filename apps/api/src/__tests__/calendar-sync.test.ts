/** Two-way staff calendar sync (PRD CAL-07, D-94), on the demo calendar client. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { GoogleCalendarClient, MicrosoftCalendarClient, MockCalendarClient, setCalendarClient } from "@skincrm/connectors";
import { hashPassword } from "@skincrm/security";
import { SEED, authenticate, clinicIdBySlug, createTestApp, letters, loginAs, resetAuthState } from "./helpers";

const { users, workingHours, appointments, people, calendarConnections } = schema;
const TAG = `cal${letters(Date.now())}`;
const PASSWORD = "Calendar-Sync-Test-2026!";
let app: FastifyInstance;
let admin: string;
let doctor: string;
let doctorId: string;
let clinicId: string;
let personId: string;
let google: MockCalendarClient;

/** A weekday about three weeks out, as YYYY-MM-DD. */
function weekday(): string {
  const d = new Date(Date.now() + 21 * 86_400_000);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/** 10:00 New York on that day, roughly (EST/EDT handled by the API; we only need a stable slot). */
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-04:00`).toISOString();

beforeAll(async () => {
  google = new MockCalendarClient("google");
  setCalendarClient("google", google);
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  const { db } = getOwnerDb();
  const [u] = await db.insert(users).values({ clinicId, email: `${TAG}@sunshine-skin.test`, fullName: `Doctor ${TAG}`, role: "practitioner", status: "active", passwordHash: await hashPassword(PASSWORD) }).returning();
  doctorId = u!.id;
  await db.insert(workingHours).values([1, 2, 3, 4, 5].map((dayOfWeek) => ({ clinicId, userId: doctorId, dayOfWeek, startTime: "09:00", endTime: "17:00" })));
  const [p] = await db.insert(people).values({ clinicId, firstName: "Maria", lastName: `Sanchez${TAG}`, displayName: `Maria Sanchez${TAG}`, emailRaw: `${TAG}@example.test`, emailNormalized: `${TAG}@example.test` }).returning();
  personId = p!.id;
  const login = await loginAs(app, `${TAG}@sunshine-skin.test`, PASSWORD);
  doctor = login.cookie!;
});

afterAll(async () => {
  const { db } = getOwnerDb();
  await db.delete(calendarConnections).where(eq(calendarConnections.userId, doctorId));
  await db.delete(appointments).where(eq(appointments.staffUserId, doctorId));
  await db.delete(schema.activities).where(eq(schema.activities.personId, personId));
  await db.delete(people).where(like(people.lastName, `%${TAG}%`));
  await db.delete(workingHours).where(eq(workingHours.userId, doctorId));
  await db.delete(schema.authTokens).where(eq(schema.authTokens.userId, doctorId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, doctorId));
  await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorUserId, [doctorId]));
  await db.delete(users).where(eq(users.id, doctorId));
  setCalendarClient("google", undefined);
  await app.close();
  await closeAllConnections();
});

const call = (cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function connect() {
  const start = await call(doctor, "POST", "/me/calendar-sync/google/start");
  expect(start.statusCode).toBe(200);
  const back = new URL(start.json().url, "http://web.test");
  expect(back.pathname).toBe("/settings/profile/calendar/google/callback");
  return { code: back.searchParams.get("code")!, state: back.searchParams.get("state")! };
}

describe("calendar sync", () => {
  it("connects once per sign-in, then mirrors bookings, moves and cancellations", async () => {
    const { code, state } = await connect();
    const done = await call(doctor, "POST", "/me/calendar-sync/google/callback", { code, state });
    expect(done.statusCode).toBe(200);
    expect(done.json().connection).toMatchObject({ provider: "google", status: "healthy", accountEmail: "demo@gmail.com" });
    expect((await call(doctor, "POST", "/me/calendar-sync/google/callback", { code, state })).statusCode).toBe(400);

    const day = weekday();
    const booked = await call(admin, "POST", "/appointments", { personId, staffUserId: doctorId, startsAt: at(day, "14:00"), durationMinutes: 30 });
    expect(booked.statusCode).toBe(201);
    await call(doctor, "POST", "/me/calendar-sync/sync");
    const created = [...google.events.values()].find((e) => e.appointmentId === booked.json().id);
    expect(created?.title).toBe(`Appointment — Maria S.`);
    expect(created?.description).not.toMatch(/@|Sanchez/);

    const moved = await call(admin, "POST", `/appointments/${booked.json().id}/reschedule`, { startsAt: at(day, "15:00"), reason: "Patient asked" });
    expect(moved.statusCode).toBe(200);
    await call(doctor, "POST", "/me/calendar-sync/sync");
    expect([...google.events.values()].some((e) => e.appointmentId === booked.json().id)).toBe(false);
    expect([...google.events.values()].find((e) => e.appointmentId === moved.json().id)?.startsAt.toISOString()).toBe(at(day, "15:00"));

    await call(admin, "POST", `/appointments/${moved.json().id}/cancel`, { reason: "Patient cancelled" });
    const after = (await call(doctor, "POST", "/me/calendar-sync/sync")).json();
    expect(after.counts.deleted).toBe(1);
    expect([...google.events.values()].some((e) => e.appointmentId === moved.json().id)).toBe(false);
  });

  it("their own busy times block booking in SkinCRM", async () => {
    const day = weekday();
    google.busy.push({ externalId: "dentist", startsAt: new Date(at(day, "10:00")), endsAt: new Date(at(day, "11:00")) });
    await call(doctor, "POST", "/me/calendar-sync/sync");
    const res = await call(admin, "GET", `/availability?date=${day}&staffUserId=${doctorId}&step=30`);
    expect(res.json()).toHaveProperty("slots");
    const slots = res.json().slots as { startsAt: string; available: boolean; reason: string | null }[];
    const ten = slots.find((s) => s.startsAt === at(day, "10:00"));
    expect(ten).toMatchObject({ available: false, reason: "busy_elsewhere" });
    expect(slots.find((s) => s.startsAt === at(day, "11:00"))?.available).toBe(true);
  });

  it("the worker picks up connections that are due", async () => {
    const { syncDueCalendars } = await import("../calendar/sync");
    const { db } = getOwnerDb();
    await db.update(calendarConnections).set({ lastSyncedAt: new Date(Date.now() - 3_600_000) }).where(eq(calendarConnections.userId, doctorId));
    expect(await syncDueCalendars()).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.userId, doctorId));
    expect(Date.now() - row!.lastSyncedAt!.getTime()).toBeLessThan(60_000);
  });

  it("disconnecting removes what SkinCRM put in their calendar", async () => {
    const day = weekday();
    const booked = await call(admin, "POST", "/appointments", { personId, staffUserId: doctorId, startsAt: at(day, "16:00"), durationMinutes: 30 });
    await call(doctor, "POST", "/me/calendar-sync/sync");
    expect([...google.events.values()].some((e) => e.appointmentId === booked.json().id)).toBe(true);
    expect((await call(doctor, "DELETE", "/me/calendar-sync")).statusCode).toBe(204);
    expect([...google.events.values()].some((e) => e.appointmentId === booked.json().id)).toBe(false);
    expect((await call(doctor, "GET", "/me/calendar-sync")).json().connection).toBeNull();
  });
});

describe("live clients (fake network)", () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

  it("Google: reads times only, skips free, cancelled and our own events", async () => {
    const calls: string[] = [];
    const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "s" }, async (url: string) => {
      calls.push(url);
      return json({ items: [
        { id: "a", start: { dateTime: "2026-11-04T15:00:00Z" }, end: { dateTime: "2026-11-04T16:00:00Z" } },
        { id: "b", transparency: "transparent", start: { dateTime: "2026-11-04T17:00:00Z" }, end: { dateTime: "2026-11-04T18:00:00Z" } },
        { id: "c", status: "cancelled", start: { dateTime: "2026-11-04T19:00:00Z" }, end: { dateTime: "2026-11-04T20:00:00Z" } },
        { id: "d", extendedProperties: { private: { skincrmAppointmentId: "x" } }, start: { dateTime: "2026-11-04T21:00:00Z" }, end: { dateTime: "2026-11-04T22:00:00Z" } },
      ] });
    });
    const busy = await client.listBusy("t", "primary", new Date("2026-11-01"), new Date("2026-11-30"));
    expect(busy.map((b) => b.externalId)).toEqual(["a"]);
    expect(new URL(calls[0]!).searchParams.get("fields")).not.toMatch(/summary|description|attendees/);
  });

  it("Microsoft: keeps the rotated refresh token", async () => {
    const client = new MicrosoftCalendarClient({ clientId: "id", clientSecret: "s", tenant: "common" }, async () => json({ access_token: "a", refresh_token: "rotated" }));
    expect(await client.accessToken("old")).toEqual({ accessToken: "a", refreshToken: "rotated" });
  });
});
