import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { FeedbackMapping } from "@skincrm/contracts";
import { clinicIdColumn, primaryId, timestamps } from "./_shared";
import { feedbackDestinationEnum, feedbackEligibilityStateEnum, feedbackEventStateEnum, feedbackMilestoneEnum } from "./enums";
import { clinics, users } from "./tenancy";
import { leads } from "./leads";

/**
 * One row per clinic per ad platform (PRD FB-01, FB-03, FB-07).
 *
 * Starts `unreviewed` and sends nothing. The checklist moves it to
 * `approved_test_only`; a successful test lets an admin move it to
 * `approved_production`. `paused` stops everything at once. Credentials for
 * *sending* conversions are separate from the lead-ingestion connection
 * (PRD: "separate connections and permission sets").
 */
export const feedbackDestinations = pgTable(
  "feedback_destinations",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    destination: feedbackDestinationEnum("destination").notNull(),
    eligibility: feedbackEligibilityStateEnum("eligibility").notNull().default("unreviewed"),
    paused: boolean("paused").notNull().default(false),
    mapping: jsonb("mapping").$type<FeedbackMapping>().notNull(),
    mappingVersion: integer("mapping_version").notNull().default(1),
    includeWhatsAppAds: boolean("include_whatsapp_ads").notNull().default(false),
    /** Non-secret: Meta dataset id, Google customer id. */
    config: jsonb("config").$type<Record<string, string | null>>().notNull().default({}),
    /** Encrypted JSON: Meta token + test code, or Google OAuth client and refresh token. */
    encryptedSecret: text("encrypted_secret"),
    checklistConfirmedBy: uuid("checklist_confirmed_by").references(() => users.id, { onDelete: "set null" }),
    checklistConfirmedAt: timestamp("checklist_confirmed_at", { withTimezone: true, mode: "date" }),
    lastTestAt: timestamp("last_test_at", { withTimezone: true, mode: "date" }),
    lastTestOk: boolean("last_test_ok"),
    lastTestDetail: text("last_test_detail"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("feedback_destinations_clinic_key").on(t.clinicId, t.destination)],
);

/**
 * The outbox (PRD FB-05, FB-06). Unique per lead, milestone and destination:
 * one milestone transition makes exactly one candidate, whatever retries or
 * replays happen. `event_id` is derived from those, so the platform can
 * de-duplicate too.
 */
export const feedbackEvents = pgTable(
  "feedback_events",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    destination: feedbackDestinationEnum("destination").notNull(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    milestone: feedbackMilestoneEnum("milestone").notNull(),
    eventId: text("event_id").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true, mode: "date" }).notNull(),
    /** Which identifier matches it to the ad — never a name, email or phone. */
    matchKey: text("match_key"),
    matchValue: text("match_value"),
    mappingVersion: integer("mapping_version").notNull(),
    state: feedbackEventStateEnum("state").notNull().default("queued"),
    reason: text("reason"),
    testMode: boolean("test_mode").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    providerResponse: text("provider_response"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("feedback_events_candidate_key").on(t.clinicId, t.destination, t.leadId, t.milestone),
    index("feedback_events_due_idx").on(t.nextAttemptAt).where(sql`${t.state} = 'queued'`),
    index("feedback_events_clinic_idx").on(t.clinicId, t.createdAt),
  ],
);

export type FeedbackDestination = typeof feedbackDestinations.$inferSelect;
export type FeedbackEvent = typeof feedbackEvents.$inferSelect;
