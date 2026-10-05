import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt, gte, isNull, lt, ne, or } from "drizzle-orm";
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
import { emitAutomationEvent, stopRunsForAppointment } from "../automations/engine";
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
  // Calendar users need names and branches without access to staff administration.
  registerRoute(app, {
    method: "GET",
    url: "/calendar/options",
    auth: { capability: "appointments:read" },
    handler: async ({ ctx }) => {
      const tx = getTx();
      const staff = await tx.select({ id: users.id, fullName: users.fullName }).from(users)
        .where(and(eq(users.status, "active"), isNull(users.archivedAt),
          ctx.capabilities.has("appointments:read_all") ? undefined : eq(users.id, ctx.userId!)))
        .orderBy(asc(users.fullName));
      const branches = await tx.select({ id: schema.branches.id, name: schema.branches.name })
        .from(schema.branches).where(isNull(schema.branches.archivedAt)).orderBy(asc(schema.branches.name));
      return { staff, branches };
    },
  });
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
      if (userId) await assertStaffBelongToClinic([userId]);
      await assertBranch(body.branchId);

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
      if (query.from > query.to) throw badRequest("The end date must be on or after the start date.");
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
      const tz = ctx.clinicTimezone ?? "UTC";

      const person = await getPerson(body.personId);
      await assertStaffBelongToClinic([body.staffUserId]);
      assertCalendarAccess(body.staffUserId);
      await assertBranch(body.branchId);
      if (body.leadId && (await getLead(body.leadId)).personId !== person.id) {
        throw badRequest("That inquiry belongs to a different person.");
      }

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
      const tz = ctx.clinicTimezone ?? "UTC";

      const existing = await loadAppointmentRow(params.id, true);
      if (existing.status === "canceled") {
        throw badRequest("That appointment was cancelled. Book a new one instead.");
      }
      if (existing.rescheduledToId) {
        throw badRequest("That appointment has already been rescheduled.");
      }

      const staffUserId = body.staffUserId ?? existing.staffUserId;
      await assertStaffBelongToClinic([staffUserId]);
      assertCalendarAccess(staffUserId);
      return rescheduleExisting(existing, { ...body, staffUserId }, tz);
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
      const existing = await loadAppointmentRow(params.id, true);
      if (existing.status === "canceled") return loadAppointment(params.id);
      if (existing.status === "rescheduled") throw badRequest("Open the replacement appointment to cancel it.");

      await cancelExisting(existing, body.reason);
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
      const existing = await loadAppointmentRow(params.id, true);
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

      if (body.status === "attended" || body.status === "no_show") {
        await emitAutomationEvent({
          type: body.status === "attended" ? "appointment_attended" : "appointment_no_show",
          appointmentId: existing.id,
          personId: existing.personId,
          leadId: existing.leadId,
          startsAt: existing.startsAt,
        });
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

      await assertStaffBelongToClinic([query.staffUserId]);
      assertCalendarAccess(query.staffUserId);
      const moving = query.rescheduleAppointmentId
        ? await loadAppointmentRow(query.rescheduleAppointmentId) : undefined;
      if (moving && !ACTIVE_APPOINTMENT_STATUSES.includes(moving.status)) {
        throw badRequest("That appointment is no longer active.");
      }
      let durationMinutes = 30;
      const typeId = moving?.consultationTypeId ?? query.consultationTypeId;
      if (typeId) {
        const rows = await tx
          .select()
          .from(consultationTypes)
          .where(eq(consultationTypes.id, typeId))
          .limit(1);
        if (!rows[0]) throw badRequest("No such consultation type.");
        if (!rows[0].isActive || rows[0].archivedAt) throw badRequest("That consultation type is inactive.");
        if (rows[0].eligibleStaffIds.length && !rows[0].eligibleStaffIds.includes(query.staffUserId)) {
          throw badRequest("That member of staff is not eligible for this consultation type.");
        }
        durationMinutes = rows[0].durationMinutes + rows[0].bufferMinutes;
      }
      if (moving) durationMinutes = (moving.endsAt.getTime() - moving.startsAt.getTime()) / 60000;

      const slots = await daySlots({ staffUserId: query.staffUserId, date: query.date, durationMinutes, step: query.step, tz, excludeAppointmentId: moving?.id });
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

export async function loadAppointmentRow(id: string, lock = false) {
  const tx = getTx();
  const query = tx.select().from(appointments).where(eq(appointments.id, id)).limit(1);
  const rows = await (lock ? query.for("update") : query);
  const row = rows[0];
  if (!row) throw notFound("No such appointment.");

  const context = getContext();
  // A practitioner may only touch their own calendar. System work (jobs, and
  // a patient's signed manage link) has no signed-in person and is allowed.
  if (context.userId && !context.capabilities.has("appointments:read_all") && row.staffUserId !== context.userId) {
    throw forbidden("That appointment belongs to another member of staff.");
  }
  return row;
}

export async function loadAppointment(id: string): Promise<AppointmentDto> {
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

export async function resolveSlot(body: {
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
    if (!typeRow.isActive || typeRow.archivedAt) throw badRequest("That consultation type is inactive.");
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
export async function insertAppointmentOrConflict(
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

export async function workingHoursFor(userId: string) {
  const tx = getTx();
  const own = await tx.select().from(workingHours).where(eq(workingHours.userId, userId));
  if (own.length > 0) return own;
  // Fall back to the clinic-wide default.
  return tx.select().from(workingHours).where(isNull(workingHours.userId));
}

export async function assertWithinWorkingHours(
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
      clinicLocalDate(startsAt, timeZone) === clinicLocalDate(endsAt, timeZone) &&
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

export async function assertStaffBelongToClinic(staffIds: readonly string[]): Promise<void> {
  if (staffIds.length === 0) return;
  const tx = getTx();
  // RLS hides another clinic's users, so this turns a silent no-op into a clear
  // validation error.
  const found = await tx.select({ id: users.id }).from(users)
    .where(and(isNull(users.archivedAt), eq(users.status, "active")));
  const valid = new Set(found.map((u) => u.id));
  const unknown = staffIds.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw badRequest("One or more of those people are not active staff at this clinic.");
  }
}

function assertCalendarAccess(staffUserId: string): void {
  const ctx = getContext();
  if (!ctx.capabilities.has("appointments:read_all") && staffUserId !== ctx.userId) {
    throw forbidden("You can only use your own calendar.");
  }
}

async function assertBranch(id?: string | null): Promise<void> {
  if (!id) return;
  const rows = await getTx().select({ id: schema.branches.id }).from(schema.branches)
    .where(and(eq(schema.branches.id, id), isNull(schema.branches.archivedAt)));
  if (!rows.length) throw badRequest("That branch does not belong to this clinic.");
}

/** Timeline entry, and advance the lead to Consultation booked. */
export async function afterBooking(
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

  await emitAutomationEvent({ type: "appointment_booked", appointmentId, personId, leadId, startsAt });

  await recordAudit({
    action: "record_created",
    entityType: "appointment",
    entityId: appointmentId,
    changeSummary: { leadId, hasLead: leadId !== null },
  });
}

/**
 * Move an appointment: the old row becomes `rescheduled`, a replacement is
 * inserted (the exclusion constraint guards the new slot), reminders are
 * re-planned. Shared by staff (routes above) and patients (public booking).
 */
export async function rescheduleExisting(
  existing: typeof appointments.$inferSelect,
  body: { startsAt: string; staffUserId?: string; durationMinutes?: number; reason: string; allowOutsideWorkingHours?: boolean },
  tz: string,
): Promise<AppointmentDto> {
  const context = getContext();
  const tx = getTx();
  const staffUserId = body.staffUserId ?? existing.staffUserId;
  if (existing.consultationTypeId) {
    const { typeRow } = await resolveSlot({ consultationTypeId: existing.consultationTypeId, startsAt: body.startsAt });
    if (typeRow!.eligibleStaffIds.length && !typeRow!.eligibleStaffIds.includes(staffUserId)) {
      throw badRequest("That member of staff is not eligible for this consultation type.");
    }
  }

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

  // Stops the old appointment's pending reminders and schedules fresh
  // ones for the new time (PRD CAL-05).
  await stopRunsForAppointment(existing.id, "The appointment was moved");
  await emitAutomationEvent({
    type: "appointment_rescheduled",
    appointmentId: replacement.id,
    personId: replacement.personId,
    leadId: replacement.leadId,
    startsAt: replacement.startsAt,
  });
  return loadAppointment(replacement.id);
}

/** Cancel, record why, and stop its reminders (via the automation event). */
export async function cancelExisting(existing: typeof appointments.$inferSelect, reason: string): Promise<void> {
  const tx = getTx();
  await tx
    .update(appointments)
    .set({
      status: "canceled",
      canceledAt: new Date(),
      changeReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(appointments.id, existing.id));

  await addActivity({
    personId: existing.personId,
    leadId: existing.leadId,
    type: "appointment_changed",
    summary: "Appointment cancelled",
    body: reason,
    entityType: "appointment",
    entityId: existing.id,
  });

  await recordAudit({
    action: "record_updated",
    entityType: "appointment",
    entityId: existing.id,
    changeSummary: { status: { from: existing.status, to: "canceled" } },
  });

  await emitAutomationEvent({
    type: "appointment_canceled",
    appointmentId: existing.id,
    personId: existing.personId,
    leadId: existing.leadId,
    startsAt: existing.startsAt,
  });

}

/**
 * Every start time on one clinic-local day for one person, marked free or not:
 * their working hours (or the clinic default), minus anything booked
 * (buffers included), minus the past. Used by staff booking and by the public
 * booking page, so both offer the same times.
 */
export async function daySlots(p: {
  staffUserId: string;
  date: string;
  durationMinutes: number;
  step: number;
  tz: string;
  excludeAppointmentId?: string;
}): Promise<AvailabilitySlot[]> {
  const tx = getTx();
  const hours = await workingHoursFor(p.staffUserId);
  const { start, end } = clinicDateRangeToUtc(p.date, p.date, p.tz);

  const booked = await tx
    .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.staffUserId, p.staffUserId),
        gt(appointments.endsAt, start),
        lt(appointments.startsAt, end),
        p.excludeAppointmentId ? ne(appointments.id, p.excludeAppointmentId) : undefined,
        ne(appointments.status, "canceled"),
        ne(appointments.status, "rescheduled"),
      ),
    );

  // Their own calendar's commitments (Google/Outlook, D-94) block time too.
  const { externalBusyFor } = await import("./sync");
  const elsewhere = await externalBusyFor(p.staffUserId, start, end);

  const dayOfWeek = clinicLocalDayOfWeek(start, p.tz);
  const todaysHours = hours.filter((h) => h.dayOfWeek === dayOfWeek && h.isActive);

  const slots: AvailabilitySlot[] = [];
  for (const window of todaysHours) {
    const windowStart = clinicLocalToUtc(p.date, window.startTime.slice(0, 5), p.tz);
    const windowEnd = clinicLocalToUtc(p.date, window.endTime.slice(0, 5), p.tz);

    for (
      let cursor = windowStart.getTime();
      cursor + p.durationMinutes * 60000 <= windowEnd.getTime();
      cursor += p.step * 60000
    ) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor + p.durationMinutes * 60000);
      const overlaps = booked.some(
        (b) => b.startsAt.getTime() < slotEnd.getTime() && b.endsAt.getTime() > slotStart.getTime(),
      );
      const busyElsewhere = !overlaps && elsewhere.some(
        (b) => b.startsAt.getTime() < slotEnd.getTime() && b.endsAt.getTime() > slotStart.getTime(),
      );
      const inPast = slotStart.getTime() < Date.now();

      slots.push({
        startsAt: slotStart.toISOString(),
        endsAt: slotEnd.toISOString(),
        available: !overlaps && !busyElsewhere && !inPast,
        reason: overlaps ? "booked" : busyElsewhere ? "busy_elsewhere" : inPast ? "in_past" : null,
      });
    }
  }

  return [...new Map(slots.map((slot) => [slot.startsAt, slot])).values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
