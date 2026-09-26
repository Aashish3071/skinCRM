/**
 * Calendar and booking (PRD CAL-01 … CAL-05).
 *
 * Requires a migrated and seeded database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";
import { clinicLocalDate, clinicLocalTime, clinicLocalToUtc, zoneOffsetMs } from "../calendar/timezone";

const { people, leads, appointments, consultationTypes, workingHours, activities, leadStageEvents } =
  schema;

let app: FastifyInstance;
let adminCookie: string;
let staff: Record<string, string>;
let savedHours: typeof workingHours.$inferSelect[] = [];

const TAG = "caltest";
const TZ = "America/New_York";

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  adminCookie = await authenticate(app, SEED.admin);
  const response = await app.inject({ method: "GET", url: "/users", headers: { cookie: adminCookie } });
  staff = Object.fromEntries(
    (response.json().items as { id: string; email: string }[]).map((u) => [u.email, u.id]),
  );
  savedHours = await getOwnerDb().db.select().from(workingHours)
    .where(eq(workingHours.userId, staff[SEED.practitioner]!));
});

afterAll(async () => {
  await cleanup();
  if (savedHours.length) await getOwnerDb().db.insert(workingHours).values(savedHours);
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

  if (ids.length > 0) {
    await db.delete(appointments).where(inArray(appointments.personId, ids));
    const leadRows = await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids));
    const leadIds = leadRows.map((r) => r.id);
    if (leadIds.length > 0) {
      await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
      await db.delete(leads).where(inArray(leads.id, leadIds));
    }
    await db.delete(activities).where(inArray(activities.personId, ids));
    await db.delete(people).where(inArray(people.id, ids));
  }
  await db.delete(consultationTypes).where(like(consultationTypes.name, `%${TAG}%`));
  if (staff) await db.delete(workingHours).where(eq(workingHours.userId, staff[SEED.practitioner]!));
}

let phoneCounter = 4000;
async function makePerson(name = `Patient ${TAG}`): Promise<string> {
  phoneCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/people",
    headers: { cookie: adminCookie },
    payload: {
      firstName: name,
      phone: `305-555-${String(phoneCounter).padStart(4, "0")}`,
      allowDuplicate: true,
    },
  });
  return response.json().id as string;
}

/** A Tuesday well clear of any daylight-saving boundary. */
function slotAt(hhmm: string, date = "2027-03-16"): string {
  return clinicLocalToUtc(date, hhmm, TZ).toISOString();
}

function book(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/appointments",
    headers: { cookie: adminCookie },
    payload: { allowOutsideWorkingHours: true, ...payload },
  });
}

describe("timezone handling (PRD CAL-01)", () => {
  it("converts clinic-local time to the right UTC instant", () => {
    // Eastern Standard Time is UTC-5 in January.
    expect(clinicLocalToUtc("2027-01-15", "09:00", TZ).toISOString()).toBe("2027-01-15T14:00:00.000Z");
    // Eastern Daylight Time is UTC-4 in July.
    expect(clinicLocalToUtc("2027-07-15", "09:00", TZ).toISOString()).toBe("2027-07-15T13:00:00.000Z");
  });

  it("gets the offset right on both sides of a daylight-saving change", () => {
    // US DST began 2027-03-14. The clinic's 09:00 shifts by an hour in UTC, and
    // an assumed fixed offset would put every appointment an hour out.
    const before = clinicLocalToUtc("2027-03-13", "09:00", TZ);
    const after = clinicLocalToUtc("2027-03-15", "09:00", TZ);
    expect(zoneOffsetMs(before, TZ) / 3_600_000).toBe(-5);
    expect(zoneOffsetMs(after, TZ) / 3_600_000).toBe(-4);
    expect(before.toISOString()).toBe("2027-03-13T14:00:00.000Z");
    expect(after.toISOString()).toBe("2027-03-15T13:00:00.000Z");
  });

  it("round-trips a local time back to itself", () => {
    for (const [date, time] of [
      ["2027-01-15", "08:30"],
      ["2027-07-04", "17:45"],
      ["2027-11-08", "23:15"],
    ] as const) {
      const utc = clinicLocalToUtc(date, time, TZ);
      expect(clinicLocalDate(utc, TZ)).toBe(date);
      expect(clinicLocalTime(utc, TZ)).toBe(time);
    }
  });
});

describe("booking (PRD CAL-03)", () => {
  it("books an appointment and returns it in the clinic's day range", async () => {
    const personId = await makePerson();
    const created = await book({
      personId,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("10:00"),
      durationMinutes: 30,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("scheduled");
    expect(created.json().staffName).toBe("Dr. Alex Chen");

    const listed = await app.inject({
      method: "GET",
      url: "/appointments?from=2027-03-16&to=2027-03-16",
      headers: { cookie: adminCookie },
    });
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().timezone).toBe(TZ);
  });

  it("refuses a second booking that overlaps the same member of staff", async () => {
    const first = await makePerson(`First ${TAG}`);
    const second = await makePerson(`Second ${TAG}`);

    expect(
      (
        await book({
          personId: first,
          staffUserId: staff[SEED.practitioner],
          startsAt: slotAt("11:00"),
          durationMinutes: 60,
        })
      ).statusCode,
    ).toBe(201);

    // Starts half an hour into the first appointment.
    const clash = await book({
      personId: second,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("11:30"),
      durationMinutes: 30,
    });

    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("conflict");
    expect(clash.json().error.message).toMatch(/already booked/i);
  });

  it("is refused by the database itself, not only by application code", async () => {
    // The guarantee has to hold even for a code path that forgets to check —
    // and for two receptionists booking the same slot in the same moment, where
    // a read-then-write check would let both through.
    const { db } = getOwnerDb();
    const personId = await makePerson(`DbLevel ${TAG}`);
    const { db: owner } = getOwnerDb();
    const clinicRows = await owner
      .select({ clinicId: people.clinicId })
      .from(people)
      .where(eq(people.id, personId));
    const clinicId = clinicRows[0]!.clinicId;

    const base = {
      clinicId,
      personId,
      staffUserId: staff[SEED.practitioner]!,
      startsAt: new Date(slotAt("08:00", "2027-04-06")),
      endsAt: new Date(slotAt("09:00", "2027-04-06")),
    };

    await db.insert(appointments).values(base);

    await expect(
      db.insert(appointments).values({
        ...base,
        startsAt: new Date(slotAt("08:30", "2027-04-06")),
        endsAt: new Date(slotAt("09:30", "2027-04-06")),
      }),
      // 23P01 is the exclusion-constraint violation.
    ).rejects.toThrow(/exclusion|conflicting key|appointments_no_staff_overlap/i);
  });

  it("allows the same time for a different member of staff", async () => {
    const a = await makePerson(`A ${TAG}`);
    const b = await makePerson(`B ${TAG}`);

    expect(
      (await book({ personId: a, staffUserId: staff[SEED.practitioner], startsAt: slotAt("13:00") }))
        .statusCode,
    ).toBe(201);
    expect(
      (await book({ personId: b, staffUserId: staff[SEED.frontDesk], startsAt: slotAt("13:00") }))
        .statusCode,
    ).toBe(201);
  });

  it("allows a back-to-back booking that only touches at the boundary", async () => {
    const a = await makePerson(`Back ${TAG}`);
    const b = await makePerson(`ToBack ${TAG}`);

    await book({
      personId: a,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("14:00"),
      durationMinutes: 30,
    });
    // tstzrange is half-open, so 14:30–15:00 does not overlap 14:00–14:30.
    const adjacent = await book({
      personId: b,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("14:30"),
      durationMinutes: 30,
    });
    expect(adjacent.statusCode).toBe(201);
  });

  it("reserves the consultation type's buffer as well as its duration", async () => {
    const typeResponse = await app.inject({
      method: "POST",
      url: "/consultation-types",
      headers: { cookie: adminCookie },
      payload: { name: `Laser ${TAG}`, durationMinutes: 30, bufferMinutes: 15 },
    });
    const typeId = typeResponse.json().id as string;

    const a = await makePerson(`Buf ${TAG}`);
    const b = await makePerson(`Buf2 ${TAG}`);

    const booked = await book({
      personId: a,
      staffUserId: staff[SEED.practitioner],
      consultationTypeId: typeId,
      startsAt: slotAt("15:00"),
    });
    expect(booked.statusCode).toBe(201);
    // The client is told 15:30; the calendar holds until 15:45.
    expect(booked.json().clientVisibleEndsAt).toBe(slotAt("15:30"));
    expect(booked.json().endsAt).toBe(slotAt("15:45"));

    // 15:35 falls inside the buffer, so it must be refused.
    const insideBuffer = await book({
      personId: b,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("15:35"),
      durationMinutes: 20,
    });
    expect(insideBuffer.statusCode).toBe(409);
  });

  it("refuses a booking outside working hours unless explicitly overridden", async () => {
    await app.inject({
      method: "PUT",
      url: "/working-hours",
      headers: { cookie: adminCookie },
      payload: {
        userId: staff[SEED.practitioner],
        // Tuesday, 09:00–17:00.
        slots: [{ dayOfWeek: 2, startTime: "09:00", endTime: "17:00" }],
      },
    });

    const personId = await makePerson(`Hours ${TAG}`);

    const tooEarly = await app.inject({
      method: "POST",
      url: "/appointments",
      headers: { cookie: adminCookie },
      payload: {
        personId,
        staffUserId: staff[SEED.practitioner],
        startsAt: slotAt("07:00"),
        durationMinutes: 30,
      },
    });
    expect(tooEarly.statusCode).toBe(422);
    expect(tooEarly.json().error.code).toBe("outside_working_hours");

    // Clinics do run the occasional early appointment; it just has to be deliberate.
    const overridden = await book({
      personId,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("07:00"),
      durationMinutes: 30,
    });
    expect(overridden.statusCode).toBe(201);
  });

  it("refuses a member of staff from another clinic", async () => {
    const personId = await makePerson(`Foreign ${TAG}`);
    const { db } = getOwnerDb();
    const foreign = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, SEED.otherClinicAdmin));

    const response = await book({
      personId,
      staffUserId: foreign[0]!.id,
      startsAt: slotAt("16:00"),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("appointment and lead stage stay separate (PRD CAL-04, BRD 6)", () => {
  async function leadWithAppointment() {
    const created = await app.inject({
      method: "POST",
      url: "/leads",
      headers: { cookie: adminCookie },
      payload: {
        person: { firstName: `Linked ${TAG}`, phone: `305-555-${++phoneCounter}`, allowDuplicate: true },
        source: "walk_in",
      },
    });
    const lead = created.json();
    const appointment = await book({
      personId: lead.personId,
      leadId: lead.id,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("09:00", "2027-03-17"),
      durationMinutes: 30,
    });
    return { lead, appointment: appointment.json() };
  }

  it("advances the lead to Consultation booked when an appointment is made", async () => {
    const { lead } = await leadWithAppointment();
    const after = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}`,
      headers: { cookie: adminCookie },
    });
    expect(after.json().stageCategory).toBe("consultation_booked");
    expect(after.json().bookedAt).not.toBeNull();
  });

  it("advances the lead to Consultation attended when marked attended", async () => {
    const { lead, appointment } = await leadWithAppointment();

    const marked = await app.inject({
      method: "POST",
      url: `/appointments/${appointment.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: "attended" },
    });
    expect(marked.json().status).toBe("attended");

    const after = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}`,
      headers: { cookie: adminCookie },
    });
    expect(after.json().stageCategory).toBe("consultation_attended");
    expect(after.json().attendedAt).not.toBeNull();
  });

  it("does not move the lead's stage when an appointment is cancelled", async () => {
    const { lead, appointment } = await leadWithAppointment();

    const cancelled = await app.inject({
      method: "POST",
      url: `/appointments/${appointment.id}/cancel`,
      headers: { cookie: adminCookie },
      payload: { reason: "Client called to cancel" },
    });
    expect(cancelled.json().status).toBe("canceled");

    const after = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}`,
      headers: { cookie: adminCookie },
    });
    // Cancelling must not silently rewrite the pipeline (BRD 6).
    expect(after.json().stageCategory).toBe("consultation_booked");
  });

  it("does not drag an attended lead back when a follow-up is booked", async () => {
    const { lead, appointment } = await leadWithAppointment();
    await app.inject({
      method: "POST",
      url: `/appointments/${appointment.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: "attended" },
    });

    await book({
      personId: lead.personId,
      leadId: lead.id,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("11:00", "2027-03-18"),
      durationMinutes: 30,
    });

    const after = await app.inject({
      method: "GET",
      url: `/leads/${lead.id}`,
      headers: { cookie: adminCookie },
    });
    expect(after.json().stageCategory).toBe("consultation_attended");
  });
});

describe("cancel and reschedule", () => {
  it("frees the slot when cancelled", async () => {
    const a = await makePerson(`Cancel ${TAG}`);
    const b = await makePerson(`Rebook ${TAG}`);

    const booked = await book({
      personId: a,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("10:00", "2027-03-19"),
      durationMinutes: 60,
    });

    // Occupied.
    expect(
      (
        await book({
          personId: b,
          staffUserId: staff[SEED.practitioner],
          startsAt: slotAt("10:00", "2027-03-19"),
        })
      ).statusCode,
    ).toBe(409);

    await app.inject({
      method: "POST",
      url: `/appointments/${booked.json().id}/cancel`,
      headers: { cookie: adminCookie },
      payload: { reason: "Client cancelled" },
    });

    // The exclusion constraint skips cancelled rows, so the slot is free again.
    expect(
      (
        await book({
          personId: b,
          staffUserId: staff[SEED.practitioner],
          startsAt: slotAt("10:00", "2027-03-19"),
        })
      ).statusCode,
    ).toBe(201);
  });

  it("reschedules onto an overlapping time, which is the common case", async () => {
    const personId = await makePerson(`Move ${TAG}`);
    const booked = await book({
      personId,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("14:00", "2027-03-22"),
      durationMinutes: 60,
    });

    // Nudged by ten minutes. Without freeing the old row first, the constraint
    // would see the original booking and refuse.
    const moved = await app.inject({
      method: "POST",
      url: `/appointments/${booked.json().id}/reschedule`,
      headers: { cookie: adminCookie },
      payload: {
        startsAt: slotAt("14:10", "2027-03-22"),
        reason: "Client running late",
        allowOutsideWorkingHours: true,
      },
    });

    expect(moved.statusCode).toBe(200);
    expect(moved.json().startsAt).toBe(slotAt("14:10", "2027-03-22"));
    expect(moved.json().rescheduledFromId).toBe(booked.json().id);

    const original = await app.inject({
      method: "GET",
      url: `/appointments/${booked.json().id}`,
      headers: { cookie: adminCookie },
    });
    expect(original.json().status).toBe("rescheduled");
    expect(original.json().rescheduledToId).toBe(moved.json().id);
  });

  it("refuses to reschedule the same appointment twice", async () => {
    const personId = await makePerson(`Twice ${TAG}`);
    const booked = await book({
      personId,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("09:00", "2027-03-23"),
    });

    const payload = {
      startsAt: slotAt("10:00", "2027-03-23"),
      reason: "Moved",
      allowOutsideWorkingHours: true,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/appointments/${booked.json().id}/reschedule`,
          headers: { cookie: adminCookie },
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/appointments/${booked.json().id}/reschedule`,
          headers: { cookie: adminCookie },
          payload,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("refuses a status change on a cancelled appointment", async () => {
    const personId = await makePerson(`Dead ${TAG}`);
    const booked = await book({
      personId,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("15:00", "2027-03-24"),
    });
    await app.inject({
      method: "POST",
      url: `/appointments/${booked.json().id}/cancel`,
      headers: { cookie: adminCookie },
      payload: { reason: "gone" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/appointments/${booked.json().id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: "attended" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("availability", () => {
  it("offers slots inside working hours and marks booked ones unavailable", async () => {
    await app.inject({
      method: "PUT",
      url: "/working-hours",
      headers: { cookie: adminCookie },
      payload: {
        userId: staff[SEED.practitioner],
        // 2027-03-16 is a Tuesday.
        slots: [{ dayOfWeek: 2, startTime: "09:00", endTime: "12:00" }],
      },
    });

    const personId = await makePerson(`Avail ${TAG}`);
    await book({
      personId,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("10:00"),
      durationMinutes: 30,
    });

    const response = await app.inject({
      method: "GET",
      url: `/availability?date=2027-03-16&staffUserId=${staff[SEED.practitioner]}&step=30`,
      headers: { cookie: adminCookie },
    });

    const slots = response.json().slots as { startsAt: string; available: boolean; reason: string | null }[];
    expect(slots.length).toBeGreaterThan(0);

    // Every slot sits inside 09:00–12:00 clinic time.
    for (const slot of slots) {
      const local = clinicLocalTime(new Date(slot.startsAt), TZ);
      expect(local >= "09:00" && local < "12:00").toBe(true);
    }

    const taken = slots.find((s) => s.startsAt === slotAt("10:00"));
    expect(taken?.available).toBe(false);
    expect(taken?.reason).toBe("booked");
  });

  it("returns nothing on a day with no working hours", async () => {
    await app.inject({
      method: "PUT",
      url: "/working-hours",
      headers: { cookie: adminCookie },
      payload: {
        userId: staff[SEED.practitioner],
        slots: [{ dayOfWeek: 2, startTime: "09:00", endTime: "12:00" }],
      },
    });
    // 2027-03-17 is a Wednesday, which has no hours.
    const response = await app.inject({
      method: "GET",
      url: `/availability?date=2027-03-17&staffUserId=${staff[SEED.practitioner]}`,
      headers: { cookie: adminCookie },
    });
    expect(response.json().slots).toHaveLength(0);
  });
});

describe("calendar permissions (PRD CAL-01)", () => {
  it("shows a practitioner only their own calendar", async () => {
    const a = await makePerson(`Theirs ${TAG}`);
    const b = await makePerson(`Mine ${TAG}`);

    await book({
      personId: a,
      staffUserId: staff[SEED.frontDesk],
      startsAt: slotAt("09:00", "2027-03-25"),
    });
    await book({
      personId: b,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("10:00", "2027-03-25"),
    });

    const practitionerCookie = await authenticate(app, SEED.practitioner);
    const response = await app.inject({
      method: "GET",
      url: "/appointments?from=2027-03-25&to=2027-03-25",
      headers: { cookie: practitionerCookie },
    });

    const items = response.json().items as { staffUserId: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.staffUserId).toBe(staff[SEED.practitioner]);
  });

  it("denies a marketing analyst the calendar entirely", async () => {
    const marketingCookie = await authenticate(app, SEED.marketing);
    const response = await app.inject({
      method: "GET",
      url: "/appointments?from=2027-03-16&to=2027-03-16",
      headers: { cookie: marketingCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not leak appointments across clinics", async () => {
    const personId = await makePerson(`Private ${TAG}`);
    const booked = await book({
      personId,
      staffUserId: staff[SEED.practitioner],
      startsAt: slotAt("11:00", "2027-03-26"),
    });

    const otherCookie = await authenticate(app, SEED.otherClinicAdmin);
    const direct = await app.inject({
      method: "GET",
      url: `/appointments/${booked.json().id}`,
      headers: { cookie: otherCookie },
    });
    expect(direct.statusCode).toBe(404);
  });

  it("denies a practitioner settings changes to consultation types", async () => {
    const practitionerCookie = await authenticate(app, SEED.practitioner);
    const response = await app.inject({
      method: "POST",
      url: "/consultation-types",
      headers: { cookie: practitionerCookie },
      payload: { name: `Nope ${TAG}`, durationMinutes: 30 },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("calendar validation and booking options", () => {
  it("gives front desk calendar and assignment choices without staff admin access", async () => {
    const cookie = await authenticate(app, SEED.frontDesk);
    for (const url of ["/calendar/options", "/leads/assignees"]) {
      const result = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(result.statusCode).toBe(200);
      expect(JSON.stringify(result.json())).not.toContain("passwordHash");
      expect(JSON.stringify(result.json())).not.toContain("email");
    }
    const doctor = await authenticate(app, SEED.practitioner);
    const options = await app.inject({ method: "GET", url: "/calendar/options", headers: { cookie: doctor } });
    expect(options.json().staff.map((s: { id: string }) => s.id)).toEqual([staff[SEED.practitioner]]);
    const other = await app.inject({ method: "GET", url: `/availability?date=2027-03-16&staffUserId=${staff[SEED.frontDesk]}`, headers: { cookie: doctor } });
    expect(other.statusCode).toBe(403);
  });

  it("rejects a booking attached to another person's inquiry", async () => {
    const lead = await app.inject({ method: "POST", url: "/leads", headers: { cookie: adminCookie },
      payload: { person: { firstName: `Mismatch ${TAG}`, phone: `305-555-${++phoneCounter}`, allowDuplicate: true }, source: "walk_in" } });
    const personId = await makePerson(`Other ${TAG}`);
    const result = await book({ personId, leadId: lead.json().id, staffUserId: staff[SEED.practitioner], startsAt: slotAt("10:00") });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.message).toMatch(/different person/);
  });

  it("rejects foreign branches and working-hours owners", async () => {
    const db = getOwnerDb().db;
    const [foreign] = await db.select().from(schema.users).where(eq(schema.users.email, SEED.otherClinicAdmin));
    const [branch] = await db.select().from(schema.branches).where(eq(schema.branches.clinicId, foreign!.clinicId));
    const personId = await makePerson();
    expect((await book({ personId, staffUserId: staff[SEED.practitioner], branchId: branch!.id, startsAt: slotAt("10:00") })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/working-hours", headers: { cookie: adminCookie }, payload: {
      userId: foreign!.id, slots: [{ dayOfWeek: 2, startTime: "09:00", endTime: "17:00" }],
    } })).statusCode).toBe(400);
  });

  it("does not book inactive types or move a consultation to ineligible staff", async () => {
    const type = await app.inject({ method: "POST", url: "/consultation-types", headers: { cookie: adminCookie },
      payload: { name: `Eligible ${TAG}`, durationMinutes: 30, eligibleStaffIds: [staff[SEED.practitioner]] } });
    const personId = await makePerson();
    const visit = await book({ personId, staffUserId: staff[SEED.practitioner], consultationTypeId: type.json().id, startsAt: slotAt("10:00") });
    const move = await app.inject({ method: "POST", url: `/appointments/${visit.json().id}/reschedule`, headers: { cookie: adminCookie },
      payload: { staffUserId: staff[SEED.frontDesk], startsAt: slotAt("11:00"), reason: "Change staff", allowOutsideWorkingHours: true } });
    expect(move.statusCode).toBe(400);
    await app.inject({ method: "PATCH", url: `/consultation-types/${type.json().id}`, headers: { cookie: adminCookie }, payload: { isActive: false } });
    expect((await book({ personId, staffUserId: staff[SEED.practitioner], consultationTypeId: type.json().id, startsAt: slotAt("12:00") })).statusCode).toBe(400);
  });

  it("includes previous-day overlaps and releases only the appointment being moved", async () => {
    await app.inject({ method: "PUT", url: "/working-hours", headers: { cookie: adminCookie }, payload: {
      userId: staff[SEED.practitioner], slots: [{ dayOfWeek: 2, startTime: "00:00", endTime: "03:00" }],
    } });
    const personId = await makePerson();
    const visit = await book({ personId, staffUserId: staff[SEED.practitioner], startsAt: slotAt("23:30", "2027-03-15"), durationMinutes: 60 });
    const base = `/availability?date=2027-03-16&staffUserId=${staff[SEED.practitioner]}`;
    const normal = await app.inject({ method: "GET", url: base, headers: { cookie: adminCookie } });
    expect(normal.json().slots[0].reason).toBe("booked");
    const moving = await app.inject({ method: "GET", url: `${base}&rescheduleAppointmentId=${visit.json().id}`, headers: { cookie: adminCookie } });
    expect(moving.json().slots[0].available).toBe(true);
    expect(moving.json().durationMinutes).toBe(60);
  });

  it("rejects impossible dates and backwards ranges", async () => {
    for (const url of ["/appointments?from=2027-02-30&to=2027-03-01", "/appointments?from=2027-03-20&to=2027-03-01"]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie: adminCookie } })).statusCode).toBe(400);
    }
  });

  it("serializes concurrent reschedules so only one replacement is created", async () => {
    const personId = await makePerson();
    const visit = await book({ personId, staffUserId: staff[SEED.practitioner], startsAt: slotAt("10:00") });
    const results = await Promise.all(["11:00", "12:00"].map((time) => app.inject({
      method: "POST", url: `/appointments/${visit.json().id}/reschedule`, headers: { cookie: adminCookie },
      payload: { startsAt: slotAt(time), reason: "Concurrent move", allowOutsideWorkingHours: true },
    })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });
});
