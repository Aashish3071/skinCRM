import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clinicIdColumn, primaryId } from "./_shared";
import { clinics, users } from "./tenancy";
import { appointments } from "./calendar";

/**
 * Two-way calendar sync (PRD CAL-07, D-94). One connection per staff member:
 * their Google Calendar or Outlook calendar. Appointments are pushed out as
 * events; their other events come back only as busy start/end times (no
 * titles), which block those times in SkinCRM booking.
 */
export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"google" | "microsoft">().notNull(),
    accountEmail: text("account_email"),
    /** Encrypted refresh token (rotated by Microsoft on use). */
    encryptedSecret: text("encrypted_secret").notNull(),
    calendarId: text("calendar_id").notNull().default("primary"),
    status: text("status").$type<"healthy" | "error">().notNull().default("healthy"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_connections_user_key").on(t.userId)],
);

/** Which provider event mirrors which appointment, so changes update rather than duplicate. */
export const calendarEventLinks = pgTable(
  "calendar_event_links",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => calendarConnections.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
    externalEventId: text("external_event_id").notNull(),
    /** The appointment's updated_at when last pushed; newer means push again. */
    syncedVersion: timestamp("synced_version", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    uniqueIndex("calendar_event_links_connection_appointment_key").on(t.connectionId, t.appointmentId),
    index("calendar_event_links_external_idx").on(t.connectionId, t.externalEventId),
  ],
);

/** The staff member's other commitments, from their calendar: times only. */
export const externalBusy = pgTable(
  "external_busy",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => calendarConnections.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("external_busy_user_time_idx").on(t.userId, t.startsAt)],
);
