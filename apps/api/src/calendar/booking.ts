import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import { z } from "zod";
import {
  isoDate,
  onlineBookingSettingsSchema,
  publicBookingSchema,
  publicCancelSchema,
  publicRescheduleSchema,
  uuidSchema,
  type PublicAppointment,
  type PublicBookingInfo,
  type PublicSlots,
} from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { schema, withoutTenantScope } from "@skincrm/db";
import { createSignedLink, verifySignedLink } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { AppError, badRequest, conflict, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { runAsSystem } from "../automations/system-context";
import { ingestSubmission } from "../intake/pipeline";
import { assertRealPhone } from "../people/service";
import { clinicDateRangeToUtc, clinicLocalDate } from "./timezone";
import {
  afterBooking,
  cancelExisting,
  daySlots,
  insertAppointmentOrConflict,
  rescheduleExisting,
} from "./routes";

/**
 * Online booking (PRD CAL-06, D-92).
 *
 * - `/book/{clinic slug}`: a patient picks a bookable consultation type, a day
 *   and a free time, and gives their name and a phone or email. They become a
 *   lead (source "Online booking") and the appointment goes through the same
 *   checks as a staff booking: working hours, buffers, the database's
 *   no-double-booking constraint, the lead moving to Qualified, confirmation
 *   and reminder automations.
 * - `/appointment/{token}`: a signed link (in confirmations and reminders as
 *   {{link.reschedule}}) to see, move or cancel that appointment until the
 *   clinic's cutoff. Moving issues a new link; the old one follows along.
 *
 * Who can be booked: the type's chosen staff if it has any, otherwise active
 * practitioners — never admins, front desk or marketing by accident. Each
 * booking goes to whoever has the fewest appointments that day.
 */
const { clinics, consultationTypes, users, appointments } = schema;
const STEP_MINUTES = 15;
const MAX_DAYS_AHEAD = 90;
const LINK_PURPOSE = "appt";

export function appointmentManageToken(clinicId: string, appointmentId: string): string {
  return createSignedLink(LINK_PURPOSE, [clinicId, appointmentId]);
}

export function appointmentManageUrl(clinicId: string, appointmentId: string): string {
  return new URL(`/appointment/${appointmentManageToken(clinicId, appointmentId)}`, getEnv().PUBLIC_WEB_URL).toString();
}

interface PublicClinic {
  id: string;
  name: string;
  phone: string | null;
  timezone: string;
  country: string;
  enabled: boolean;
  cutoffHours: number;
  hasLogo: boolean;
}

/** Cross-tenant by necessity: the slug is all a public visitor has. Reads only these columns. */
async function clinicBySlug(slug: string): Promise<PublicClinic | null> {
  if (!/^[a-z0-9-]{2,80}$/.test(slug)) return null;
  const rows = await withoutTenantScope("online booking: resolve clinic by slug", (db) =>
    db.select({
      id: clinics.id, name: clinics.name, phone: clinics.phone, timezone: clinics.timezone, country: clinics.country,
      enabled: clinics.onlineBookingEnabled, cutoffHours: clinics.bookingChangeCutoffHours, logo: clinics.logoUpdatedAt, archivedAt: clinics.archivedAt,
    }).from(clinics).where(eq(clinics.slug, slug)).limit(1),
  );
  const c = rows[0];
  if (!c || c.archivedAt) return null;
  return { id: c.id, name: c.name, phone: c.phone, timezone: c.timezone, country: c.country, enabled: c.enabled, cutoffHours: c.cutoffHours, hasLogo: Boolean(c.logo) };
}

async function bookableClinic(slug: string): Promise<PublicClinic> {
  const clinic = await clinicBySlug(slug);
  // One answer for "no such clinic" and "not taking online bookings".
  if (!clinic || !clinic.enabled) throw notFound("This clinic doesn't take online bookings. Please call them to book.");
  return clinic;
}

async function bookableType(typeId: string) {
  const [type] = await getTx().select().from(consultationTypes)
    .where(and(eq(consultationTypes.id, typeId), eq(consultationTypes.bookableOnline, true), eq(consultationTypes.isActive, true), isNull(consultationTypes.archivedAt)))
    .limit(1);
  if (!type) throw badRequest("That appointment type can't be booked online.");
  return type;
}

/** The type's chosen staff, or active practitioners. */
async function eligibleStaff(type: typeof consultationTypes.$inferSelect): Promise<string[]> {
  const active = and(eq(users.status, "active"), isNull(users.archivedAt));
  const rows = type.eligibleStaffIds.length
    ? await getTx().select({ id: users.id }).from(users).where(and(active, inArray(users.id, type.eligibleStaffIds)))
    : await getTx().select({ id: users.id }).from(users).where(and(active, eq(users.role, "practitioner")));
  return rows.map((r) => r.id);
}

function assertBookableDate(date: string, tz: string): void {
  const today = clinicLocalDate(new Date(), tz);
  const last = clinicLocalDate(new Date(Date.now() + MAX_DAYS_AHEAD * 86_400_000), tz);
  if (date < today || date > last) throw badRequest(`Choose a day between today and ${MAX_DAYS_AHEAD} days from now.`);
}

/** Free start times on a day, across the given staff, with who is free at each. */
async function freeTimes(staffIds: string[], date: string, durationMinutes: number, tz: string, excludeAppointmentId?: string) {
  const byTime = new Map<string, string[]>();
  for (const staffUserId of staffIds) {
    const slots = await daySlots({ staffUserId, date, durationMinutes, step: STEP_MINUTES, tz, excludeAppointmentId });
    for (const slot of slots) {
      if (!slot.available) continue;
      byTime.set(slot.startsAt, [...(byTime.get(slot.startsAt) ?? []), staffUserId]);
    }
  }
  return byTime;
}

/** Of those free, the one with the lightest day; ties keep a stable order. */
async function leastBusy(staffIds: string[], startsAt: Date, tz: string): Promise<string> {
  if (staffIds.length === 1) return staffIds[0]!;
  const day = clinicLocalDate(startsAt, tz);
  const { start, end } = clinicDateRangeToUtc(day, day, tz);
  const rows = await getTx().select({ staffUserId: appointments.staffUserId }).from(appointments)
    .where(and(inArray(appointments.staffUserId, staffIds), gte(appointments.startsAt, start), lt(appointments.startsAt, end),
      ne(appointments.status, "canceled"), ne(appointments.status, "rescheduled")));
  const load = new Map(staffIds.map((id) => [id, 0]));
  for (const r of rows) load.set(r.staffUserId, (load.get(r.staffUserId) ?? 0) + 1);
  return [...staffIds].sort((a, b) => load.get(a)! - load.get(b)! || a.localeCompare(b))[0]!;
}

/** Follow a moved appointment to where it is now (a link keeps working after a reschedule). */
async function currentAppointment(token: string) {
  const fields = verifySignedLink(LINK_PURPOSE, token, 2);
  if (!fields || !uuidSchema.safeParse(fields[0]).success || !uuidSchema.safeParse(fields[1]).success) {
    throw notFound("This link isn't valid. Please contact the clinic.");
  }
  const [clinicId, appointmentId] = fields as [string, string];
  return { clinicId, appointmentId };
}

async function loadFollowed(appointmentId: string) {
  let id = appointmentId;
  for (let hop = 0; hop < 20; hop++) {
    const [row] = await getTx().select().from(appointments).where(eq(appointments.id, id)).limit(1);
    if (!row) throw notFound("This link isn't valid. Please contact the clinic.");
    if (!row.rescheduledToId) return row;
    id = row.rescheduledToId;
  }
  throw notFound("This link isn't valid. Please contact the clinic.");
}

async function publicView(clinicId: string, row: typeof appointments.$inferSelect): Promise<PublicAppointment> {
  const [clinic] = await getTx().select().from(clinics).limit(1);
  const type = row.consultationTypeId
    ? (await getTx().select({ name: consultationTypes.name }).from(consultationTypes).where(eq(consultationTypes.id, row.consultationTypeId)).limit(1))[0]
    : undefined;
  const deadline = new Date(row.startsAt.getTime() - clinic!.bookingChangeCutoffHours * 3_600_000);
  return {
    clinicName: clinic!.name,
    clinicPhone: clinic!.phone,
    typeName: type?.name ?? null,
    startsAt: row.startsAt.toISOString(),
    endsAt: (row.clientVisibleEndsAt ?? row.endsAt).toISOString(),
    timezone: clinic!.timezone,
    status: row.status,
    changeDeadline: deadline.toISOString(),
    canChange: clinic!.onlineBookingEnabled && (row.status === "scheduled" || row.status === "confirmed") && Date.now() < deadline.getTime(),
    manageToken: appointmentManageToken(clinicId, row.id),
  };
}

function assertCanChange(view: PublicAppointment): void {
  if (view.canChange) return;
  if (view.status === "canceled") throw badRequest("This appointment is already cancelled.");
  throw new AppError(409, "too_late_to_change", `It's too close to the appointment to change it online. Please call ${view.clinicName}${view.clinicPhone ? ` on ${view.clinicPhone}` : ""}.`);
}

const slug = z.object({ slug: z.string().min(2).max(80) });
const token = z.object({ token: z.string().min(20).max(400) });
const limits = { max: 30, timeWindow: "1 minute" };

export function registerBookingRoutes(app: FastifyInstance): void {
  // --- Settings → Calendar → Online booking (admin) -------------------------
  registerRoute(app, {
    method: "GET",
    url: "/settings/online-booking",
    auth: { capability: "settings:read" },
    handler: async () => {
      const tx = getTx();
      const [clinic] = await tx.select().from(clinics).limit(1);
      const types = await tx.select({ id: consultationTypes.id, name: consultationTypes.name, bookableOnline: consultationTypes.bookableOnline })
        .from(consultationTypes).where(and(eq(consultationTypes.isActive, true), isNull(consultationTypes.archivedAt)));
      return {
        enabled: clinic!.onlineBookingEnabled,
        cutoffHours: clinic!.bookingChangeCutoffHours,
        url: new URL(`/book/${clinic!.slug}`, getEnv().PUBLIC_WEB_URL).toString(),
        types,
      };
    },
  });

  registerRoute(app, {
    method: "PUT",
    url: "/settings/online-booking",
    auth: { capability: "settings:write" },
    body: onlineBookingSettingsSchema,
    handler: async ({ body }) => {
      const tx = getTx();
      const [clinic] = await tx.select({ id: clinics.id }).from(clinics).limit(1);
      if (body.enabled && body.bookableTypeIds.length === 0) throw badRequest("Choose at least one appointment type patients can book.");
      await tx.update(clinics).set({ onlineBookingEnabled: body.enabled, bookingChangeCutoffHours: body.cutoffHours, updatedAt: new Date() }).where(eq(clinics.id, clinic!.id));
      await tx.update(consultationTypes).set({ bookableOnline: false });
      if (body.bookableTypeIds.length) await tx.update(consultationTypes).set({ bookableOnline: true }).where(inArray(consultationTypes.id, body.bookableTypeIds));
      await recordAudit({ action: "settings_changed", entityType: "clinic", entityId: clinic!.id, changeSummary: { onlineBooking: body.enabled, bookableTypes: body.bookableTypeIds.length, cutoffHours: body.cutoffHours } });
      return { ok: true };
    },
  });

  // --- Public: booking page ---------------------------------------------------
  // The clinic's logo for its booking page. A plain route: it sends bytes.
  app.get("/public/booking/:slug/logo", { config: { rateLimit: limits } }, async (request, reply) => {
    const clinic = await clinicBySlug((request.params as { slug: string }).slug);
    if (!clinic?.enabled || !clinic.hasLogo) return reply.code(404).send();
    const [row] = await withoutTenantScope("online booking: clinic logo", (db) =>
      db.select({ data: clinics.logoData, mime: clinics.logoMime }).from(clinics).where(eq(clinics.id, clinic.id)).limit(1));
    if (!row?.data || !row.mime) return reply.code(404).send();
    return reply.header("content-type", row.mime).header("cache-control", "public, max-age=300").send(Buffer.from(row.data, "base64"));
  });

  registerRoute(app, {
    method: "GET",
    url: "/public/booking/:slug",
    auth: false,
    params: slug,
    rateLimit: limits,
    handler: async ({ params }): Promise<PublicBookingInfo> => {
      const clinic = await bookableClinic(params.slug);
      return runAsSystem(clinic.id, async () => {
        const types = await getTx().select({ id: consultationTypes.id, name: consultationTypes.name, durationMinutes: consultationTypes.durationMinutes })
          .from(consultationTypes)
          .where(and(eq(consultationTypes.bookableOnline, true), eq(consultationTypes.isActive, true), isNull(consultationTypes.archivedAt)));
        return { clinicName: clinic.name, clinicPhone: clinic.phone, timezone: clinic.timezone, hasLogo: clinic.hasLogo, types, cutoffHours: clinic.cutoffHours };
      });
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/public/booking/:slug/slots",
    auth: false,
    params: slug,
    query: z.object({ typeId: uuidSchema, date: isoDate }),
    rateLimit: limits,
    handler: async ({ params, query }): Promise<PublicSlots> => {
      const clinic = await bookableClinic(params.slug);
      assertBookableDate(query.date, clinic.timezone);
      return runAsSystem(clinic.id, async () => {
        const type = await bookableType(query.typeId);
        const times = await freeTimes(await eligibleStaff(type), query.date, type.durationMinutes + type.bufferMinutes, clinic.timezone);
        return { date: query.date, timezone: clinic.timezone, startTimes: [...times.keys()].sort() };
      });
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/public/booking/:slug",
    auth: false,
    params: slug,
    body: publicBookingSchema,
    rateLimit: { max: 10, timeWindow: "1 minute" },
    status: 201,
    handler: async ({ params, body }) => {
      const clinic = await bookableClinic(params.slug);
      // Honeypot tripped: look successful, do nothing.
      if (body.website) return { status: "received" };
      const startsAt = new Date(body.startsAt);
      assertBookableDate(clinicLocalDate(startsAt, clinic.timezone), clinic.timezone);
      if (body.phone) assertRealPhone(body.phone, clinic.country);

      return runAsSystem(clinic.id, async () => {
        const type = await bookableType(body.typeId);
        const date = clinicLocalDate(startsAt, clinic.timezone);
        const free = (await freeTimes(await eligibleStaff(type), date, type.durationMinutes + type.bufferMinutes, clinic.timezone)).get(startsAt.toISOString());
        if (!free?.length) throw conflict("Sorry — that time was just taken. Please pick another.");
        const staffUserId = await leastBusy(free, startsAt, clinic.timezone);

        const consent = [
          ...(body.email ? [{ channel: "email" as const, purpose: "operational" as const, source: "web_form" as const, capturedText: "Online booking: confirm and remind me about this appointment" }] : []),
          ...(body.phone ? [{ channel: "whatsapp" as const, purpose: "operational" as const, source: "web_form" as const, capturedText: "Online booking: confirm and remind me about this appointment" }] : []),
          ...(body.marketingConsent
            ? [...(body.email ? ["email" as const] : []), ...(body.phone ? ["whatsapp" as const] : [])].map((channel) => ({ channel, purpose: "promotional" as const, source: "web_form" as const, capturedText: "Online booking: send me news and offers" }))
            : []),
        ];
        const outcome = await ingestSubmission({
          platform: "website",
          source: "online_booking",
          externalId: `booking:${randomUUID()}`,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          email: body.email,
          serviceInterest: type.name,
          inquiryNote: body.note ?? null,
          consent,
          clinicCountry: clinic.country,
        });
        if (outcome.status !== "created") throw badRequest(outcome.status === "failed" ? outcome.reason : "Please try again.");

        const clientVisibleEndsAt = new Date(startsAt.getTime() + type.durationMinutes * 60_000);
        const appointment = await insertAppointmentOrConflict({
          clinicId: clinic.id,
          personId: outcome.personId,
          leadId: outcome.leadId,
          staffUserId,
          consultationTypeId: type.id,
          startsAt,
          clientVisibleEndsAt,
          endsAt: new Date(clientVisibleEndsAt.getTime() + type.bufferMinutes * 60_000),
          note: "Booked online by the patient",
          createdByUserId: null,
        });
        await afterBooking(appointment.id, outcome.leadId, outcome.personId, startsAt, clinic.timezone);
        return publicView(clinic.id, appointment);
      });
    },
  });

  // --- Public: manage an appointment -----------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/public/appointments/:token",
    auth: false,
    params: token,
    rateLimit: limits,
    handler: async ({ params }) => {
      const { clinicId, appointmentId } = await currentAppointment(params.token);
      return runAsSystem(clinicId, async () => publicView(clinicId, await loadFollowed(appointmentId)));
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/public/appointments/:token/slots",
    auth: false,
    params: token,
    query: z.object({ date: isoDate }),
    rateLimit: limits,
    handler: async ({ params, query }): Promise<PublicSlots> => {
      const { clinicId, appointmentId } = await currentAppointment(params.token);
      return runAsSystem(clinicId, async () => {
        const row = await loadFollowed(appointmentId);
        assertCanChange(await publicView(clinicId, row));
        const tz = getContext().clinicTimezone ?? "UTC";
        assertBookableDate(query.date, tz);
        const staff = await staffForMove(row);
        const minutes = Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000);
        const times = await freeTimes(staff, query.date, minutes, tz, row.id);
        return { date: query.date, timezone: tz, startTimes: [...times.keys()].sort() };
      });
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/public/appointments/:token/reschedule",
    auth: false,
    params: token,
    body: publicRescheduleSchema,
    rateLimit: { max: 10, timeWindow: "1 minute" },
    handler: async ({ params, body }) => {
      const { clinicId, appointmentId } = await currentAppointment(params.token);
      return runAsSystem(clinicId, async () => {
        const row = await loadFollowed(appointmentId);
        assertCanChange(await publicView(clinicId, row));
        const tz = getContext().clinicTimezone ?? "UTC";
        const startsAt = new Date(body.startsAt);
        assertBookableDate(clinicLocalDate(startsAt, tz), tz);
        const minutes = Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000);
        const free = (await freeTimes(await staffForMove(row), clinicLocalDate(startsAt, tz), minutes, tz, row.id)).get(startsAt.toISOString());
        if (!free?.length) throw conflict("Sorry — that time was just taken. Please pick another.");
        // Keep the same person when they're free; otherwise the least busy.
        const staffUserId = free.includes(row.staffUserId) ? row.staffUserId : await leastBusy(free, startsAt, tz);
        const visibleMinutes = Math.round(((row.clientVisibleEndsAt ?? row.endsAt).getTime() - row.startsAt.getTime()) / 60_000);
        const moved = await rescheduleExisting(row, { startsAt: body.startsAt, staffUserId, durationMinutes: visibleMinutes, reason: "Moved online by the patient" }, tz);
        return publicView(clinicId, await loadFollowed(moved.id));
      });
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/public/appointments/:token/cancel",
    auth: false,
    params: token,
    body: publicCancelSchema,
    rateLimit: { max: 10, timeWindow: "1 minute" },
    handler: async ({ params, body }) => {
      const { clinicId, appointmentId } = await currentAppointment(params.token);
      return runAsSystem(clinicId, async () => {
        const row = await loadFollowed(appointmentId);
        assertCanChange(await publicView(clinicId, row));
        await cancelExisting(row, body.reason ? `Cancelled online by the patient: ${body.reason}` : "Cancelled online by the patient");
        return publicView(clinicId, await loadFollowed(row.id));
      });
    },
  });
}

/** The appointment's type rules if it has a type, otherwise just its current staff member. */
async function staffForMove(row: typeof appointments.$inferSelect): Promise<string[]> {
  if (!row.consultationTypeId) return [row.staffUserId];
  const [type] = await getTx().select().from(consultationTypes).where(eq(consultationTypes.id, row.consultationTypeId)).limit(1);
  if (!type) return [row.staffUserId];
  const staff = await eligibleStaff(type);
  return staff.includes(row.staffUserId) ? staff : [row.staffUserId, ...staff];
}
