import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { archivedAt, clinicIdColumn, primaryId, timestamps } from "./_shared";
import { appointmentStatusEnum } from "./enums";
import { branches, clinics, users } from "./tenancy";
import { leads } from "./leads";
import { people } from "./people";

/**
 * What a clinic offers to book (PRD CAL-02).
 *
 * `bufferMinutes` is clean-down or turnaround time after the appointment. It is
 * kept separate from the duration because the client is told the duration, while
 * the buffer only affects what the calendar will accept next.
 */
export const consultationTypes = pgTable(
  "consultation_types",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    /** Empty means anyone may be booked for it. */
    eligibleStaffIds: jsonb("eligible_staff_ids").$type<string[]>().notNull().default([]),
    /** Shown to the client on a booking link; kept generic by default (PRD 4.4). */
    publicLabel: text("public_label"),
    isActive: boolean("is_active").notNull().default(true),
    /** Offered on the public booking page (PRD CAL-06). */
    bookableOnline: boolean("bookable_online").notNull().default(false),
    position: integer("position").notNull().default(0),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [index("consultation_types_clinic_idx").on(t.clinicId, t.isActive)],
);

/**
 * When a member of staff, or the clinic as a whole, is available (PRD CAL-02).
 *
 * `userId` null means these are the clinic's default hours, used for anyone
 * without their own. Times are local wall-clock in the clinic's timezone —
 * "we open at nine" stays true across a daylight-saving change, which a stored
 * UTC time would not.
 */
export const workingHours = pgTable(
  "working_hours",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    /** 0 = Sunday, matching JavaScript's getDay(). */
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index("working_hours_clinic_idx").on(t.clinicId, t.userId, t.dayOfWeek),
    uniqueIndex("working_hours_unique_slot").on(t.clinicId, t.userId, t.dayOfWeek, t.startTime),
  ],
);

/**
 * A booked consultation (PRD CAL-03, CAL-04).
 *
 * Overlap is prevented by a Postgres exclusion constraint on
 * `(staff_user_id, tstzrange(starts_at, ends_at))`, added in
 * `sql/920_constraints.sql`. A read-then-write check races: two receptionists
 * booking the same slot at the same moment would both see it free. Only the
 * database can decide this, and it refuses the second write.
 *
 * `status` is deliberately independent of the lead's stage: cancelling an
 * appointment must not silently rewrite where the lead sits in the pipeline
 * (BRD 6).
 */
export const appointments = pgTable(
  "appointments",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    consultationTypeId: uuid("consultation_type_id").references(() => consultationTypes.id, {
      onDelete: "set null",
    }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),

    /** Stored UTC, displayed in the clinic timezone (BRD 9). */
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * Includes the consultation type's buffer, because the exclusion constraint
     * works on this range — the buffer has to be part of what is reserved or it
     * protects nothing.
     */
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
    /** What the client is told, without the buffer. */
    clientVisibleEndsAt: timestamp("client_visible_ends_at", { withTimezone: true, mode: "date" }),

    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    /** Why it was cancelled, rescheduled or marked no-show (PRD CAL-03). */
    changeReason: text("change_reason"),

    /** Scheduling notes only. Clinical detail is out of scope for this product. */
    note: text("note"),

    /** Set on the old row when a reschedule creates a replacement. */
    rescheduledToId: uuid("rescheduled_to_id"),
    rescheduledFromId: uuid("rescheduled_from_id"),

    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    attendedAt: timestamp("attended_at", { withTimezone: true, mode: "date" }),
    canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "date" }),

    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("appointments_clinic_start_idx").on(t.clinicId, t.startsAt),
    index("appointments_staff_start_idx").on(t.staffUserId, t.startsAt),
    index("appointments_person_idx").on(t.personId),
    index("appointments_lead_idx").on(t.leadId),
    index("appointments_status_idx").on(t.clinicId, t.status),
  ],
);

export const consultationTypesRelations = relations(consultationTypes, ({ one }) => ({
  clinic: one(clinics, { fields: [consultationTypes.clinicId], references: [clinics.id] }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  person: one(people, { fields: [appointments.personId], references: [people.id] }),
  lead: one(leads, { fields: [appointments.leadId], references: [leads.id] }),
  staff: one(users, { fields: [appointments.staffUserId], references: [users.id] }),
  consultationType: one(consultationTypes, {
    fields: [appointments.consultationTypeId],
    references: [consultationTypes.id],
  }),
}));

export type ConsultationType = typeof consultationTypes.$inferSelect;
export type WorkingHours = typeof workingHours.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
