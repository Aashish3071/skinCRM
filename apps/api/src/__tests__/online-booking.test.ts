/** Online booking and "manage your appointment" links (PRD CAL-06, D-92). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { SEED, authenticate, clinicIdBySlug, createTestApp, letters, resetAuthState } from "./helpers";

const { clinics, consultationTypes, users, workingHours, appointments, people, leads, leadStageEvents, activities, tasks, sourceSubmissions, consentRecords, automationEnrollments } = schema;
const TAG = `obk${letters(Date.now())}`;
let app: FastifyInstance;
let admin: string;
let clinicId: string;
let practitionerId: string;
let typeId: string;
let saved: { enabled: boolean; cutoff: number };

/** A day two weeks out, in the clinic's (New York) calendar. */
const day = (offset = 14) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  const { db } = getOwnerDb();
  const [c] = await db.select().from(clinics).where(eq(clinics.id, clinicId));
  saved = { enabled: c!.onlineBookingEnabled, cutoff: c!.bookingChangeCutoffHours };
  // An isolated practitioner and type, so no real calendar is touched.
  const [u] = await db.insert(users).values({ clinicId, email: `${TAG}@sunshine-skin.test`, fullName: `Doctor ${TAG}`, role: "practitioner", status: "active" }).returning();
  practitionerId = u!.id;
  await db.insert(workingHours).values([0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ clinicId, userId: practitionerId, dayOfWeek, startTime: "09:00", endTime: "12:00" })));
  const [t] = await db.insert(consultationTypes).values({ clinicId, name: `Skin check ${TAG}`, durationMinutes: 30, bufferMinutes: 15, eligibleStaffIds: [practitionerId] }).returning();
  typeId = t!.id;
});

afterAll(async () => {
  const { db } = getOwnerDb();
  const ids = (await db.select({ id: people.id }).from(people).where(like(people.lastName, `%${TAG}%`))).map((r) => r.id);
  await db.delete(appointments).where(eq(appointments.staffUserId, practitionerId));
  if (ids.length) {
    const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
    if (leadIds.length) {
      await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
      await db.delete(automationEnrollments).where(inArray(automationEnrollments.leadId, leadIds));
    }
    await db.delete(activities).where(inArray(activities.personId, ids));
    await db.delete(tasks).where(inArray(tasks.personId, ids));
    await db.delete(consentRecords).where(inArray(consentRecords.personId, ids));
    await db.delete(leads).where(inArray(leads.personId, ids));
    await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.personId, ids));
    await db.delete(people).where(inArray(people.id, ids));
  }
  await db.delete(consultationTypes).where(eq(consultationTypes.id, typeId));
  await db.delete(workingHours).where(eq(workingHours.userId, practitionerId));
  await db.delete(users).where(eq(users.id, practitionerId));
  await db.update(clinics).set({ onlineBookingEnabled: saved.enabled, bookingChangeCutoffHours: saved.cutoff }).where(eq(clinics.id, clinicId));
  await app.close();
  await closeAllConnections();
});

const pub = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const patient = (n: string, extra: Record<string, unknown> = {}) => ({
  typeId, firstName: `Ana${n}`, lastName: `Lopez ${TAG}`, email: `ana.${n}.${TAG}@example.test`, contactConsent: true, ...extra,
});

async function firstFreeTime(date = day()) {
  const r = await pub("GET", `/public/booking/${SEED.clinicA}/slots?typeId=${typeId}&date=${date}`);
  expect(r.statusCode).toBe(200);
  return r.json().startTimes as string[];
}

describe("online booking", () => {
  it("is closed until an admin turns it on, and then only offers chosen types", async () => {
    await getOwnerDb().db.update(clinics).set({ onlineBookingEnabled: false }).where(eq(clinics.id, clinicId));
    expect((await pub("GET", `/public/booking/${SEED.clinicA}`)).statusCode).toBe(404);

    const enable = await app.inject({ method: "PUT", url: "/settings/online-booking", headers: { cookie: admin }, payload: { enabled: true, cutoffHours: 24, bookableTypeIds: [typeId] } });
    expect(enable.statusCode).toBe(200);
    const info = await pub("GET", `/public/booking/${SEED.clinicA}`);
    expect(info.statusCode).toBe(200);
    expect(info.json().types.map((t: { id: string }) => t.id)).toEqual([typeId]);
    expect(JSON.stringify(info.json())).not.toMatch(/Doctor|@sunshine-skin/);
  });

  it("books a patient into a free slot: a lead from Online booking, moved to Qualified, the slot then taken", async () => {
    const times = await firstFreeTime();
    // 09:00–12:00 with 30 + 15 minutes reserved → 09:00 … 11:15 every 15 minutes.
    expect(times).toHaveLength(10);
    const booked = await pub("POST", `/public/booking/${SEED.clinicA}`, patient("a", { startsAt: times[0] }));
    expect(booked.statusCode).toBe(201);
    expect(booked.json()).toMatchObject({ status: "scheduled", canChange: true, startsAt: times[0] });

    const { db } = getOwnerDb();
    const [appt] = await db.select().from(appointments).where(and(eq(appointments.staffUserId, practitionerId), eq(appointments.startsAt, new Date(times[0]!))));
    expect(appt).toBeTruthy();
    const [lead] = await db.select().from(leads).where(eq(leads.id, appt!.leadId!));
    expect(lead!.source).toBe("online_booking");
    expect(lead!.bookedAt).not.toBeNull();

    // The buffer counts: 09:00–09:45 is reserved, so 09:15 and 09:30 are gone too.
    const after = await firstFreeTime();
    expect(after).not.toContain(times[0]);
    expect(after).not.toContain(times[1]);
    const clash = await pub("POST", `/public/booking/${SEED.clinicA}`, patient("b", { startsAt: times[0] }));
    expect(clash.statusCode).toBe(409);
  });

  it("refuses bad input without creating anything, and silently ignores bots", async () => {
    const times = await firstFreeTime(day(15));
    expect((await pub("POST", `/public/booking/${SEED.clinicA}`, patient("c", { startsAt: times[0], contactConsent: false }))).statusCode).toBe(400);
    expect((await pub("POST", `/public/booking/${SEED.clinicA}`, patient("c", { startsAt: times[0], email: undefined, phone: "000 000 0000" }))).statusCode).toBe(400);
    expect((await pub("POST", `/public/booking/${SEED.clinicA}`, patient("c", { startsAt: new Date(Date.now() - 86_400_000).toISOString() }))).statusCode).toBe(400);
    const bot = await pub("POST", `/public/booking/${SEED.clinicA}`, patient("bot", { startsAt: times[0], website: "http://spam" }));
    expect(bot.json()).toEqual({ status: "received" });
    expect(await firstFreeTime(day(15))).toContain(times[0]);
  });
});

describe("manage link", () => {
  it("shows, moves (with a fresh link the old one follows) and cancels; tampering fails", async () => {
    const times = await firstFreeTime(day(16));
    const booked = (await pub("POST", `/public/booking/${SEED.clinicA}`, patient("d", { startsAt: times[0] }))).json();
    const token = booked.manageToken as string;

    expect((await pub("GET", `/public/appointments/${token.slice(0, -2)}xx`)).statusCode).toBe(404);
    const view = await pub("GET", `/public/appointments/${token}`);
    expect(view.json()).toMatchObject({ status: "scheduled", canChange: true, typeName: `Skin check ${TAG}` });

    const options = (await pub("GET", `/public/appointments/${token}/slots?date=${day(17)}`)).json().startTimes as string[];
    const moved = await pub("POST", `/public/appointments/${token}/reschedule`, { startsAt: options[2] });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().startsAt).toBe(options[2]);
    expect(moved.json().manageToken).not.toBe(token);
    // The original link now shows the moved appointment.
    expect((await pub("GET", `/public/appointments/${token}`)).json().startsAt).toBe(options[2]);

    const cancelled = await pub("POST", `/public/appointments/${token}/cancel`, { reason: "Feeling better" });
    expect(cancelled.json()).toMatchObject({ status: "canceled", canChange: false });
    expect((await pub("POST", `/public/appointments/${token}/reschedule`, { startsAt: options[3] })).statusCode).toBe(400);
  });

  it("stops online changes inside the clinic's cutoff", async () => {
    const times = await firstFreeTime(day(3));
    const booked = (await pub("POST", `/public/booking/${SEED.clinicA}`, patient("e", { startsAt: times[0] }))).json();
    await getOwnerDb().db.update(clinics).set({ bookingChangeCutoffHours: 168 }).where(eq(clinics.id, clinicId));
    const view = (await pub("GET", `/public/appointments/${booked.manageToken}`)).json();
    expect(view.canChange).toBe(false);
    const tooLate = await pub("POST", `/public/appointments/${booked.manageToken}/cancel`, {});
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json().error.message).toMatch(/too close/);
    await getOwnerDb().db.update(clinics).set({ bookingChangeCutoffHours: 24 }).where(eq(clinics.id, clinicId));
  });
});
