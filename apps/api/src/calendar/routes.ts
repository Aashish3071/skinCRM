import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  availabilityQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  createConsultationTypeSchema,
  listAppointmentsQuerySchema,
  rescheduleAppointmentSchema,
  setAppointmentStatusSchema,
  setWorkingHoursSchema,
  updateConsultationTypeSchema,
  uuidSchema,
  type AppointmentDto,
  type AvailabilitySlot,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { AppError, badRequest, conflict, forbidden, notFound } from "../errors";
import { diffSummary, recordAudit } from "../audit";
import { registerRoute } from "../route";
import { addActivity, getLead, stageByCategory } from "../leads/service";
import { getPerson } from "../people/service";
import {
  clinicDateRangeToUtc,
  clinicLocalDate,
  clinicLocalDayOfWeek,
  clinicLocalTime,
  clinicLocalToUtc,
} from "./timezone";

const { appointments, consultationTypes, workingHours, people, users } = schema;

/** Postgres raises this when the exclusion constraint refuses an overlap. */
const EXCLUSION_VIOLATION = "23P01";

export function registerCalendarRoutes(app: FastifyInstance): void {
  // --- Consultation types (PRD CAL-02) -----------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/consultation-types",
    auth: { capability: "appointments:read" },
    handler: async () => {
      const tx = getTx();
      const rows = await tx
        .select()
        .from(consultationTypes)
        .where(isNull(consultationTypes.archivedAt))
        .orderBy(asc(consultationTypes.position), asc(consultationTypes.name));
      return { items: rows.map(serializeType) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/consultation-types",
    auth: { capability: "settings:write" },
    body: createConsultationTypeSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();
      await assertStaffBelongToClinic(body.eligibleStaffIds);

      const inserted = await tx
        .insert(consultationTypes)
        .values({ clinicId: context.clinicId!, ...body })
        .returning();

      await recordAudit({
        action: "settings_changed",
        entityType: "consultation_type",
        entityId: inserted[0]!.id,
        changeSummary: { created: body.name, durationMinutes: body.durationMinutes },
      });
      return serializeType(inserted[0]!);
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/consultation-types/:id",
    auth: { capability: "settings:write" },
    params: z.object({ id: uuidSchema }),
    body: updateConsultationTypeSchema,
    handler: async ({ params, body }) => {
      const tx = getTx();
      const rows = await tx
        .select()
        .from(consultationTypes)
        .where(eq(consultationTypes.id, params.id))
        .limit(1);
      const before = rows[0];
      if (!before) throw notFound("No such consultation type.");
      if (body.eligibleStaffIds) await assertStaffBelongToClinic(body.eligibleStaffIds);

      const updates = { ...body, updatedAt: new Date() };
      const updated = await tx
        .update(consultationTypes)
        .set(updates)
        .where(eq(consultationTypes.id, params.id))
        .returning();

      await recordAudit({
        action: "settings_changed",
        entityType: "consultation_type",
        entityId: params.id,
        changeSummary: diffSummary(before as unknown as Record<string, unknown>, updates),
      });
      return serializeType(updated[0]!);
    },
  });

  // --- Working hours ------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/working-hours",
    auth: { capability: "appointments:read" },
    query: z.object({ userId: uuidSchema.optional() }),
    handler: async ({ query }) => {
      const tx = getTx();
      const rows = await tx
        .select()
        .from(workingHours)
        .where(
          query.userId
            ? or(eq(workingHours.userId, query.userId), isNull(workingHours.userId))
            : undefined,
        )
        .orderBy(asc(workingHours.dayOfWeek), asc(workingHours.startTime));
      return {
        items: rows.map((row) => ({
          id: row.id,
          userId: row.userId,
          branchId: row.branchId,
          dayOfWeek: row.dayOfWeek,
          startTime: row.startTime.slice(0, 5),
          endTime: row.endTime.slice(0, 5),
          isActive: row.isActive,
        })),
      };
    },
  });

  registerRoute(app, {
    method: "PUT",
    url: "/working-hours",
    auth: { capability: "settings:write" },
    body: setWorkingHoursSchema,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();
      const userId = body.userId ?? null;

      for (const slot of body.slots) {
        if (slot.endTime <= slot.startTime) {
          throw badRequest(`${slot.startTime}–${slot.endTime} ends before it starts.`);
        }
      }

      // Replace the whole set for this person: a partial update would leave
      // yesterday's hours behind and is impossible to reason about.
      await tx
        .delete(workingHours)
        .where(userId ? eq(workingHours.userId, userId) : isNull(workingHours.userId));

      if (body.slots.length > 0) {
        await tx.insert(workingHours).values(
          body.slots.map((slot) => ({
            clinicId: context.clinicId!,
            userId,
            branchId: body.branchId ?? null,
            dayOfWeek: slot.dayOfWeek,
            startTime: slot.startTime,
            endTime: slot.endTime,
          })),
        );
      }

      await recordAudit({
        action: "settings_changed",
        entityType: "working_hours",
        entityId: userId,
        changeSummary: { slotCount: body.slots.length, scope: userId ? "user" : "clinic_default" },
      });
      return { ok: true, slotCount: body.slots.length };
    },
  });

  // --- Calendar (PRD CAL-01) ---------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/appointments",
    auth: { capability: "appointments:read" },
    query: listAppointmentsQuerySchema,
    handler: async ({ query, ctx }) => {
      const tx = getTx();
      const tz = ctx.clinicTimezone ?? "UTC";
      const { start, end } = clinicDateRangeToUtc(query.from, query.to, tz);

      const conditions = [gte(appointments.startsAt, start), lt(appointments.startsAt, end)];

      /**
       * A practitioner without `appointments:read_all` sees only their own
       * calendar (PRD CAL-01). Narrowed in SQL, not after fetching.
       */
      if (!ctx.capabilities.has("appointments:read_all")) {
        conditions.push(eq(appointments.staffUserId, ctx.userId!));
      } else if (query.staffUserId) {
        conditions.push(eq(appointments.staffUserId, query.staffUserId));
      }

      if (query.branchId) conditions.push(eq(appointments.branchId, query.branchId));
      if (query.personId) conditions.push(eq(appointments.personId, query.personId));
      if (!query.includeCanceled) conditions.push(ne(appointments.status, "canceled"));

      const rows = await tx
        .select(appointmentSelection)
        .from(appointments)
        .innerJoin(people, eq(people.id, appointments.personId))
        .innerJoin(users, eq(users.id, appointments.staffUserId))
        .leftJoin(consultationTypes, eq(consultationTypes.id, appointments.consultationTypeId))
        .where(and(...conditions))
        .orderBy(asc(appointments.startsAt));

      return { items: rows.map(serializeAppointment), timezone: tz };
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/appointments/:id",
    auth: { capability: "appointments:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => loadAppointment(params.id),
  });

  // --- Book (PRD CAL-03) --------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/appointments",
    auth: { capability: "appointments:write" },
    body: createAppointmentSchema,
    status: 201,
    handler: async ({ body, ctx }) => {
      const context = getContext();
      const tx = getTx();
      const tz = ctx.clinicTimezone ?? "UTC";

      const person = await getPerson(body.personId);
      await assertStaffBelongToClinic([body.staffUserId]);

      const { startsAt, endsAt, clientVisibleEndsAt, typeRow } = await resolveSlot(body);

      if (!body.allowOutsideWorkingHours) {
        await assertWithinWorkingHours(body.staffUserId, startsAt, clientVisibleEndsAt, tz);
      }
      if (typeRow && typeRow.eligibleStaffIds.length > 0 && !typeRow.eligibleStaffIds.includes(body.staffUserId)) {
        throw badRequest(`That member of staff is not set up for ${typeRow.name}.`);
      }

      const inserted = await insertAppointmentOrConflict({
        clinicId: context.clinicId!,
        personId: person.id,
        leadId: body.leadId ?? null,
        staffUserId: body.staffUserId,
        consultationTypeId: body.consultationTypeId ?? null,
        branchId: body.branchId ?? null,
        startsAt,
        endsAt,
        clientVisibleEndsAt,
        note: body.note ?? null,
        createdByUserId: context.userId,
      });

      await afterBooking(inserted.id, body.leadId ?? null, person.id, startsAt, tz);
      return loadAppointment(inserted.id);
    },
  });

  // --- Reschedule ---------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/appointments/:id/reschedule",
    auth: { capability: "appointments:write" },
    params: z.object({ id: uuidSchema }),
    body: rescheduleAppointmentSchema,
    handler: async ({ params, body, ctx }) => {
      const context = getContext();
      const tx = getTx();
      const tz = ctx.clinicTimezone ?? "UTC";

      const existing = await loadAppointmentRow(params.id);
      if (existing.status === "canceled") {
        throw badRequest("That appointment was cancelled. Book a new one instead.");
      }
      if (existing.rescheduledToId) {
        throw badRequest("That appointment has already been rescheduled.");
      }

      const staffUserId = body.staffUserId ?? existing.staffUserId;
      if (body.staffUserId) await assertStaffBelongToClinic([body.staffUserId]);

      const durationMinutes =
        body.durationMinutes ??
        Math.round(
          ((existing.clientVisibleEndsAt ?? existing.endsAt).getTime() - existing.startsAt.getTime()) /
            60000,
        );
      const bufferMinutes = Math.round(
        (existing.endsAt.getTime() - (existing.clientVisibleEndsAt ?? existing.endsAt).getTime()) / 60000,
      );

      const startsAt = new Date(body.startsAt);
      const clientVisibleEndsAt = new Date(startsAt.getTime() + durationMinutes * 60000);
      const endsAt = new Date(clientVisibleEndsAt.getTime() + bufferMinutes * 60000);

      if (!body.allowOutsideWorkingHours) {
        await assertWithinWorkingHours(staffUserId, startsAt, clientVisibleEndsAt, tz);
      }

      /**
       * Free the old slot first, in the same transaction. The exclusion
       * constraint would otherwise see the original booking and refuse a move
       * to an overlapping time — including nudging an appointment by ten
       * minutes, which is the most common reschedule there is.
       */
      await tx
        .update(appointments)
        .set({ status: "rescheduled", changeReason: body.reason, updatedAt: new Date() })
        .where(eq(appointments.id, existing.id));

      const replacement = await insertAppointmentOrConflict({
        clinicId: context.clinicId!,
        personId: existing.personId,
        leadId: existing.leadId,
        staffUserId,
        consultationTypeId: existing.consultationTypeId,
        branchId: existing.branchId,
        startsAt,
        endsAt,
        clientVisibleEndsAt,
        note: existing.note,
        createdByUserId: context.userId,
        rescheduledFromId: existing.id,
      });

      await tx
        .update(appointments)
        .set({ rescheduledToId: replacement.id })
        .where(eq(appointments.id, existing.id));

      await addActivity({
        personId: existing.personId,
        leadId: existing.leadId,
        type: "appointment_changed",
        summary: `Appointment moved to ${clinicLocalDate(startsAt, tz)} ${clinicLocalTime(startsAt, tz)}`,
        body: body.reason,
        entityType: "appointment",
        entityId: replacement.id,
      });

      await recordAudit({
        action: "record_updated",
        entityType: "appointment",
        entityId: existing.id,
        changeSummary: { rescheduledTo: replacement.id, reasonGiven: true },
      });

      // TODO(phase 4): cancel the reminder jobs attached to the old row and
      // schedule new ones (PRD CAL-05). The messaging layer does not exist yet.
      return loadAppointment(replacement.id);
    },
  });

  // --- Cancel -------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/appointments/:id/cancel",
    auth: { capability: "appointments:write" },
    params: z.object({ id: uuidSchema }),
    body: cancelAppointmentSchema,
    handler: async ({ params, body, ctx }) => {
      const tx = getTx();
      const existing = await loadAppointmentRow(params.id);
      if (existing.status === "canceled") return loadAppointment(params.id);

      await tx
        .update(appointments)
        .set({
          status: "canceled",
          canceledAt: new Date(),
          changeReason: body.reason,
          updatedAt: new Date(),
        })
        .where(eq(appointments.id, existing.id));

      await addActivity({
        personId: existing.personId,
        leadId: existing.leadId,
        type: "appointment_changed",
        summary: "Appointment cancelled",
        body: body.reason,
        entityType: "appointment",
        entityId: existing.id,
      });

      await recordAudit({
        action: "record_updated",
        entityType: "appointment",
        entityId: existing.id,
        changeSummary: { status: { from: existing.status, to: "canceled" } },
      });

      // Cancelling does NOT move the lead's stage. Appointment status and lead
      // stage are separate concepts, and silently rewriting the pipeline would
      // lose why the lead was where it was (BRD 6).
      void ctx;
      return loadAppointment(existing.id);
    },
  });

  // --- Status (PRD CAL-04) -----------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/appointments/:id/status",
    auth: { capability: "appointments:write" },
    params: z.object({ id: uuidSchema }),
    body: setAppointmentStatusSchema,
    handler: async ({ params, body, ctx }) => {
      const tx = getTx();
      const existing = await loadAppointmentRow(params.id);
      if (existing.status === "canceled" || existing.status === "rescheduled") {
        throw badRequest("That appointment is no longer active.");
      }

      const now = new Date();
      const updates: Record<string, unknown> = {
        status: body.status,
        changeReason: body.reason ?? existing.changeReason,
        updatedAt: now,
      };
      if (body.status === "confirmed" && !existing.confirmedAt) updates.confirmedAt = now;
      if (body.status === "attended" && !existing.attendedAt) updates.attendedAt = now;

      await tx.update(appointments).set(updates).where(eq(appointments.id, existing.id));

      await addActivity({
        personId: existing.personId,
        leadId: existing.leadId,
        type: "appointment_changed",
        summary: `Appointment marked ${body.status.replace(/_/g, " ")}`,
        body: body.reason ?? null,
        entityType: "appointment",
        entityId: existing.id,
      });

      /**
       * Attendance is the one status that also advances the lead, because
       * "consultation attended" is a pipeline milestone the clinic reports on
       * and later feeds back to ad platforms. Only ever forward, and only when
       * the lead has not already moved past it.
       */
      if (body.status === "attended" && existing.leadId) {
        const lead = await getLead(existing.leadId);
        if (!lead.attendedAt && !lead.convertedAt) {
          const attendedStage = await stageByCategory("consultation_attended");
          const { changeStage } = await import("../leads/service");
          await changeStage({ leadId: lead.id, stageId: attendedStage.id, silent: true });
        }
      }

      await recordAudit({
        action: "record_updated",
        entityType: "appointment",
        entityId: existing.id,
        changeSummary: { status: { from: existing.status, to: body.status } },
      });

      void ctx;
      return loadAppointment(existing.id);
    },
  });

  // --- Availability -------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/availability",
    auth: { capability: "appointments:read" },
    query: availabilityQuerySchema,
    handler: async ({ query, ctx }) => {
      const tx = getTx();
      const tz = ctx.clinicTimezone ?? "UTC";

      let durationMinutes = 30;
      if (query.consultationTypeId) {
        const rows = await tx
          .select()
          .from(consultationTypes)
          .where(eq(consultationTypes.id, query.consultationTypeId))
          .limit(1);
        if (!rows[0]) throw badRequest("No such consultation type.");
        durationMinutes = rows[0].durationMinutes + rows[0].bufferMinutes;
      }

      const hours = await workingHoursFor(query.staffUserId);
      const { start, end } = clinicDateRangeToUtc(query.date, query.date, tz);

      const booked = await tx
        .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
        .from(appointments)
        .where(
          and(
            eq(appointments.staffUserId, query.staffUserId),
            gte(appointments.startsAt, start),
            lt(appointments.startsAt, end),
            ne(appointments.status, "canceled"),
            ne(appointments.status, "rescheduled"),
          ),
        );

      const dayOfWeek = clinicLocalDayOfWeek(start, tz);
      const todaysHours = hours.filter((h) => h.dayOfWeek === dayOfWeek && h.isActive);

      const slots: AvailabilitySlot[] = [];
      for (const window of todaysHours) {
        const windowStart = clinicLocalToUtc(query.date, window.startTime.slice(0, 5), tz);
        const windowEnd = clinicLocalToUtc(query.date, window.endTime.slice(0, 5), tz);

        for (
          let cursor = windowStart.getTime();
          cursor + durationMinutes * 60000 <= windowEnd.getTime();
          cursor += query.step * 60000
        ) {
          const slotStart = new Date(cursor);
          const slotEnd = new Date(cursor + durationMinutes * 60000);
          const overlaps = booked.some(
            (b) => b.startsAt.getTime() < slotEnd.getTime() && b.endsAt.getTime() > slotStart.getTime(),
          );
          const inPast = slotStart.getTime() < Date.now();

          slots.push({
            startsAt: slotStart.toISOString(),
            endsAt: slotEnd.toISOString(),
            available: !overlaps && !inPast,
            reason: overlaps ? "booked" : inPast ? "in_past" : null,
          });
        }
      }

      return { date: query.date, timezone: tz, durationMinutes, slots };
    },
  });
}

// --- Helpers --------------------------------------------------------------

const appointmentSelection = {
  appointment: appointments,
  personName: people.displayName,
  personPhone: people.phoneRaw,
  staffName: users.fullName,
  consultationTypeName: consultationTypes.name,
};

type AppointmentJoinRow = {
  appointment: typeof appointments.$inferSelect;
  personName: string;
  personPhone: string | null;
  staffName: string;
  consultationTypeName: string | null;
};

function serializeAppointment(row: AppointmentJoinRow): AppointmentDto {
  const a = row.appointment;
  return {
    id: a.id,
    personId: a.personId,
    personName: row.personName,
    personPhone: row.personPhone,
    leadId: a.leadId,
    staffUserId: a.staffUserId,
    staffName: row.staffName,
    consultationTypeId: a.consultationTypeId,
    consultationTypeName: row.consultationTypeName,
    branchId: a.branchId,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    clientVisibleEndsAt: a.clientVisibleEndsAt?.toISOString() ?? null,
    status: a.status,
    changeReason: a.changeReason,
    note: a.note,
    rescheduledToId: a.rescheduledToId,
    rescheduledFromId: a.rescheduledFromId,
    createdAt: a.createdAt.toISOString(),
  };
}

function serializeType(row: typeof consultationTypes.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    bufferMinutes: row.bufferMinutes,
    eligibleStaffIds: row.eligibleStaffIds ?? [],
    publicLabel: row.publicLabel,
    isActive: row.isActive,
    position: row.position,
  };
}

async function loadAppointmentRow(id: string) {
  const tx = getTx();
  const rows = await tx.select().from(appointments).where(eq(appointments.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("No such appointment.");

  const context = getContext();
  // A practitioner may only touch their own calendar.
  if (!context.capabilities.has("appointments:read_all") && row.staffUserId !== context.userId) {
    throw forbidden("That appointment belongs to another member of staff.");
  }
  return row;
}

async function loadAppointment(id: string): Promise<AppointmentDto> {
  await loadAppointmentRow(id);
  const tx = getTx();
  const rows = await tx
    .select(appointmentSelection)
    .from(appointments)
    .innerJoin(people, eq(people.id, appointments.personId))
    .innerJoin(users, eq(users.id, appointments.staffUserId))
    .leftJoin(consultationTypes, eq(consultationTypes.id, appointments.consultationTypeId))
    .where(eq(appointments.id, id))
    .limit(1);
  if (!rows[0]) throw notFound("No such appointment.");
  return serializeAppointment(rows[0] as AppointmentJoinRow);
}

async function resolveSlot(body: {
  consultationTypeId?: string | null;
  startsAt: string;
  durationMinutes?: number;
}) {
  const tx = getTx();
  let typeRow: typeof consultationTypes.$inferSelect | undefined;

  if (body.consultationTypeId) {
    const rows = await tx
      .select()
      .from(consultationTypes)
      .where(eq(consultationTypes.id, body.consultationTypeId))
      .limit(1);
    typeRow = rows[0];
    if (!typeRow) throw badRequest("That consultation type does not belong to this clinic.");
  }

  const durationMinutes = body.durationMinutes ?? typeRow?.durationMinutes ?? 30;
  const bufferMinutes = typeRow?.bufferMinutes ?? 0;

  const startsAt = new Date(body.startsAt);
  const clientVisibleEndsAt = new Date(startsAt.getTime() + durationMinutes * 60000);
  // The reserved range includes the buffer; that is what must not overlap.
  const endsAt = new Date(clientVisibleEndsAt.getTime() + bufferMinutes * 60000);

  return { startsAt, endsAt, clientVisibleEndsAt, typeRow };
}

/**
 * Insert, turning the exclusion-constraint violation into a clear 409.
 *
 * The constraint is the real guard; this only translates its error. Checking
 * for a clash in application code first would still race, so it is not done.
 */
async function insertAppointmentOrConflict(
  values: typeof appointments.$inferInsert,
): Promise<typeof appointments.$inferSelect> {
  const tx = getTx();
  try {
    const inserted = await tx.insert(appointments).values(values).returning();
    return inserted[0]!;
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw conflict(
        "That time is already booked for this member of staff. Pick another slot or another person.",
        { startsAt: ["Overlaps an existing appointment"] },
      );
    }
    throw error;
  }
}

function isExclusionViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === EXCLUSION_VIOLATION
  );
}

async function workingHoursFor(userId: string) {
  const tx = getTx();
  const own = await tx.select().from(workingHours).where(eq(workingHours.userId, userId));
  if (own.length > 0) return own;
  // Fall back to the clinic-wide default.
  return tx.select().from(workingHours).where(isNull(workingHours.userId));
}

async function assertWithinWorkingHours(
  staffUserId: string,
  startsAt: Date,
  endsAt: Date,
  timeZone: string,
): Promise<void> {
  const hours = await workingHoursFor(staffUserId);
  // No hours configured at all means the clinic has not set them up yet;
  // refusing every booking would be worse than allowing it.
  if (hours.length === 0) return;

  const day = clinicLocalDayOfWeek(startsAt, timeZone);
  const startLocal = clinicLocalTime(startsAt, timeZone);
  const endLocal = clinicLocalTime(endsAt, timeZone);

  const fits = hours.some(
    (h) =>
      h.isActive &&
      h.dayOfWeek === day &&
      startLocal >= h.startTime.slice(0, 5) &&
      endLocal <= h.endTime.slice(0, 5),
  );

  if (!fits) {
    throw new AppError(
      422,
      "outside_working_hours",
      `${startLocal}–${endLocal} is outside that person's working hours. Tick "book anyway" to override.`,
      { startsAt: ["Outside working hours"] },
    );
  }
}

async function assertStaffBelongToClinic(staffIds: readonly string[]): Promise<void> {
  if (staffIds.length === 0) return;
  const tx = getTx();
  // RLS hides another clinic's users, so this turns a silent no-op into a clear
  // validation error.
  const found = await tx.select({ id: users.id }).from(users).where(isNull(users.archivedAt));
  const valid = new Set(found.map((u) => u.id));
  const unknown = staffIds.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw badRequest("One or more of those people are not active staff at this clinic.");
  }
}

/** Timeline entry, and advance the lead to Consultation booked. */
async function afterBooking(
  appointmentId: string,
  leadId: string | null,
  personId: string,
  startsAt: Date,
  timeZone: string,
): Promise<void> {
  await addActivity({
    personId,
    leadId,
    type: "appointment_created",
    summary: `Appointment booked for ${clinicLocalDate(startsAt, timeZone)} at ${clinicLocalTime(startsAt, timeZone)}`,
    entityType: "appointment",
    entityId: appointmentId,
  });

  if (leadId) {
    const lead = await getLead(leadId);
    // Only ever forward: a lead already attended or converted must not be
    // dragged back to "booked" by a follow-up appointment.
    if (!lead.attendedAt && !lead.convertedAt) {
      const stage = await stageByCategory("consultation_booked");
      const { changeStage } = await import("../leads/service");
      await changeStage({ leadId, stageId: stage.id, silent: true });
    }
  }

  await recordAudit({
    action: "record_created",
    entityType: "appointment",
    entityId: appointmentId,
    changeSummary: { leadId, hasLead: leadId !== null },
  });
}
