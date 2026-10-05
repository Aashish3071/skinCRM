import { z } from "zod";
import { isoDate, isoDateTime, optionalShortText, shortText, uuidSchema } from "./common";
import { APPOINTMENT_STATUSES, type AppointmentStatus } from "./enums";
import { optionalEmailField, optionalNameField, optionalPhoneField } from "./contact";

// --- Consultation types (PRD CAL-02) --------------------------------------

export const consultationTypeSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int().positive(),
  bufferMinutes: z.number().int().nonnegative(),
  eligibleStaffIds: z.array(uuidSchema),
  publicLabel: z.string().nullable(),
  isActive: z.boolean(),
  position: z.number().int(),
});
export type ConsultationTypeDto = z.infer<typeof consultationTypeSchema>;

export const createConsultationTypeSchema = z.object({
  name: shortText(120),
  description: optionalShortText(500),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  /** Clean-down time after the appointment. Reserved, but not shown to clients. */
  bufferMinutes: z.coerce.number().int().min(0).max(240).default(0),
  /** Empty means anyone can be booked for it. */
  eligibleStaffIds: z.array(uuidSchema).default([]),
  /**
   * What a client sees. Kept generic by default so a calendar invite or a
   * reminder does not disclose the service (PRD 4.4, BRD 9).
   */
  publicLabel: optionalShortText(120),
  isActive: z.boolean().default(true),
  position: z.coerce.number().int().min(0).default(0),
});
export type CreateConsultationType = z.infer<typeof createConsultationTypeSchema>;

export const updateConsultationTypeSchema = createConsultationTypeSchema.partial();
export type UpdateConsultationType = z.infer<typeof updateConsultationTypeSchema>;

// --- Working hours --------------------------------------------------------

/** `HH:MM` in the clinic's local time. */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 09:00");

export const workingHoursSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema.nullable(),
  branchId: uuidSchema.nullable(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string(),
  endTime: z.string(),
  isActive: z.boolean(),
});
export type WorkingHoursDto = z.infer<typeof workingHoursSchema>;

export const setWorkingHoursSchema = z.object({
  /** Null sets the clinic-wide default, used by anyone without their own. */
  userId: uuidSchema.nullish(),
  branchId: uuidSchema.nullish(),
  slots: z
    .array(
      z.object({
        dayOfWeek: z.coerce.number().int().min(0).max(6),
        startTime: timeOfDay,
        endTime: timeOfDay,
      }),
    )
    .max(50),
});
export type SetWorkingHours = z.infer<typeof setWorkingHoursSchema>;

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// --- Appointments (PRD CAL-03, CAL-04) ------------------------------------

export const createAppointmentSchema = z.object({
  personId: uuidSchema,
  leadId: uuidSchema.nullish(),
  staffUserId: uuidSchema,
  consultationTypeId: uuidSchema.nullish(),
  branchId: uuidSchema.nullish(),
  startsAt: isoDateTime,
  /** Overrides the consultation type's duration when the visit is unusual. */
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  note: optionalShortText(2000),
  /**
   * Book outside the staff member's working hours. Allowed, but deliberate:
   * clinics do run the occasional early or late appointment.
   */
  allowOutsideWorkingHours: z.boolean().default(false),
});
export type CreateAppointment = z.infer<typeof createAppointmentSchema>;

export const rescheduleAppointmentSchema = z.object({
  startsAt: isoDateTime,
  staffUserId: uuidSchema.optional(),
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  reason: shortText(500),
  allowOutsideWorkingHours: z.boolean().default(false),
});
export type RescheduleAppointment = z.infer<typeof rescheduleAppointmentSchema>;

export const cancelAppointmentSchema = z.object({
  reason: shortText(500),
});
export type CancelAppointment = z.infer<typeof cancelAppointmentSchema>;

/**
 * Statuses a user can set directly. `rescheduled` is not among them: it is set
 * by the reschedule flow, which also creates the replacement row, so allowing
 * it here would leave an appointment marked rescheduled with nothing to point at.
 */
export const SETTABLE_APPOINTMENT_STATUSES = [
  "scheduled",
  "confirmed",
  "attended",
  "no_show",
] as const satisfies readonly AppointmentStatus[];

export const setAppointmentStatusSchema = z.object({
  status: z.enum(SETTABLE_APPOINTMENT_STATUSES),
  reason: optionalShortText(500),
});
export type SetAppointmentStatus = z.infer<typeof setAppointmentStatusSchema>;

export const appointmentSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  personName: z.string(),
  personPhone: z.string().nullable(),
  leadId: uuidSchema.nullable(),
  staffUserId: uuidSchema,
  staffName: z.string(),
  consultationTypeId: uuidSchema.nullable(),
  consultationTypeName: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  clientVisibleEndsAt: isoDateTime.nullable(),
  status: z.enum(APPOINTMENT_STATUSES),
  changeReason: z.string().nullable(),
  note: z.string().nullable(),
  rescheduledToId: uuidSchema.nullable(),
  rescheduledFromId: uuidSchema.nullable(),
  createdAt: isoDateTime,
});
export type AppointmentDto = z.infer<typeof appointmentSchema>;

export const listAppointmentsQuerySchema = z.object({
  /** Clinic-local dates, inclusive. Converted to UTC bounds server-side. */
  from: isoDate,
  to: isoDate,
  staffUserId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  personId: uuidSchema.optional(),
  includeCanceled: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;

/** Statuses that still hold the slot. Anything else frees it. */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  "scheduled",
  "confirmed",
  "attended",
  "no_show",
];

// --- Availability ---------------------------------------------------------

export const availabilityQuerySchema = z.object({
  date: isoDate,
  staffUserId: uuidSchema,
  consultationTypeId: uuidSchema.optional(),
  /** When moving a visit, reuse its duration/buffer and release its old slot. */
  rescheduleAppointmentId: uuidSchema.optional(),
  /** Slot granularity in minutes. */
  step: z.coerce.number().int().min(5).max(120).default(15),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const availabilitySlotSchema = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  available: z.boolean(),
  /** Why not, when unavailable: `booked` or `outside_hours`. */
  reason: z.enum(["booked", "outside_hours", "in_past"]).nullable(),
});
export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

// --- Online booking (PRD CAL-06) ---------------------------------------------

/** What the public booking page needs. Nothing about staff or other patients. */
export interface PublicBookingInfo {
  clinicName: string;
  clinicPhone: string | null;
  timezone: string;
  hasLogo: boolean;
  types: { id: string; name: string; durationMinutes: number }[];
  cutoffHours: number;
}

/** Free start times on one day, any eligible member of staff. */
export interface PublicSlots {
  date: string;
  timezone: string;
  startTimes: string[];
}

export const publicBookingSchema = z
  .object({
    typeId: uuidSchema,
    startsAt: isoDateTime,
    firstName: optionalNameField(120).refine((v) => v !== null, "Enter your first name"),
    lastName: optionalNameField(120),
    phone: optionalPhoneField,
    email: optionalEmailField,
    note: optionalShortText(1000),
    /** Reminders and messages about this booking. Required to book. */
    contactConsent: z.literal(true, { errorMap: () => ({ message: "Tick the box so we can confirm and remind you" }) }),
    marketingConsent: z.boolean().default(false),
    /** Honeypot: people leave it empty. */
    website: z.string().max(200).optional(),
  })
  .refine((v) => Boolean(v.phone) || Boolean(v.email), { message: "Give a phone number or an email address", path: ["phone"] });
export type PublicBooking = z.infer<typeof publicBookingSchema>;

export interface PublicAppointment {
  clinicName: string;
  clinicPhone: string | null;
  typeName: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: "scheduled" | "confirmed" | "canceled" | "attended" | "no_show" | "rescheduled";
  /** Moving or cancelling online is allowed until this time. */
  changeDeadline: string;
  canChange: boolean;
  /** The current link: a moved appointment gets a new one. */
  manageToken: string;
}

export const publicRescheduleSchema = z.object({ startsAt: isoDateTime });
export const publicCancelSchema = z.object({ reason: optionalShortText(500) });

export const onlineBookingSettingsSchema = z.object({
  enabled: z.boolean(),
  cutoffHours: z.coerce.number().int().min(0).max(168),
  bookableTypeIds: z.array(uuidSchema).max(50),
});
