import { relations, sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  AutomationStep,
  AutomationStopCondition,
  AutomationTriggerConfig,
  EnrollmentHistoryEntry,
} from "@skincrm/contracts";
import { archivedAt, clinicIdColumn, primaryId, timestamps } from "./_shared";
import { automationStatusEnum, automationTriggerEnum, enrollmentStateEnum } from "./enums";
import { clinics, users } from "./tenancy";
import { people } from "./people";
import { leads } from "./leads";
import { appointments } from "./calendar";

/**
 * Automation rules (PRD MSG-03): one trigger, an ordered list of steps.
 *
 * Trigger and steps are JSON validated by the shared Zod schemas rather than a
 * table per step type. The canvas saves the whole rule at once, steps have no
 * identity outside their rule, and a normalized layout would turn every edit
 * into a diff-and-reconcile across six tables for nothing.
 *
 * `trigger_type` duplicates `trigger.type` as a real column so "which active
 * rules fire on this event" is an indexed lookup.
 */
export const automationRules = pgTable(
  "automation_rules",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** New rules start paused: nothing sends until an admin switches it on. */
    status: automationStatusEnum("status").notNull().default("paused"),
    triggerType: automationTriggerEnum("trigger_type").notNull(),
    trigger: jsonb("trigger").$type<AutomationTriggerConfig>().notNull(),
    steps: jsonb("steps").$type<AutomationStep[]>().notNull(),
    stopWhen: jsonb("stop_when").$type<AutomationStopCondition[]>().notNull().default([]),
    /** Bumped on every save; each run records the version it started on. */
    version: integer("version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [index("automation_rules_trigger_idx").on(t.clinicId, t.triggerType, t.status)],
);

/**
 * One person's run through one rule (PRD MSG-03: "inspect enrollment").
 *
 * `steps` is a snapshot taken at enrollment. Editing a rule must not change
 * what a run already in flight does halfway through — a reminder sequence
 * that silently gains a promotional step for people already enrolled would be
 * a consent problem, not just a surprise.
 *
 * The table doubles as the job queue: the worker claims rows whose
 * `next_run_at` has passed (D-59). Enrolling happens in the same transaction
 * as the event that caused it, so a trigger can never be lost between the
 * database and a separate queue.
 */
export const automationEnrollments = pgTable(
  "automation_enrollments",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    ruleVersion: integer("rule_version").notNull(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),

    /**
     * What makes this run unique for its rule — `lead:<id>` or `appt:<id>`.
     * The unique index means a replayed event cannot enroll anyone twice.
     */
    dedupeKey: text("dedupe_key").notNull(),

    steps: jsonb("steps").$type<AutomationStep[]>().notNull(),
    stopWhen: jsonb("stop_when").$type<AutomationStopCondition[]>().notNull().default([]),

    state: enrollmentStateEnum("state").notNull().default("active"),
    /** Index of the next step to run. Equal to steps.length when finished. */
    currentStep: integer("current_step").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: "date" }),
    /** Claimed by a worker until then. Expires, so a crashed worker's claim is retried. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    attempts: integer("attempts").notNull().default(0),

    stopReason: text("stop_reason"),
    lastError: text("last_error"),
    history: jsonb("history").$type<EnrollmentHistoryEntry[]>().notNull().default([]),

    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("automation_enrollments_dedupe_key").on(t.ruleId, t.dedupeKey),
    // The worker's claim query.
    index("automation_enrollments_due_idx")
      .on(t.nextRunAt)
      .where(sql`${t.state} = 'active'`),
    index("automation_enrollments_rule_idx").on(t.clinicId, t.ruleId, t.startedAt),
    index("automation_enrollments_person_idx").on(t.personId),
    index("automation_enrollments_appointment_idx").on(t.appointmentId),
  ],
);

export const automationRulesRelations = relations(automationRules, ({ many }) => ({
  enrollments: many(automationEnrollments),
}));

export const automationEnrollmentsRelations = relations(automationEnrollments, ({ one }) => ({
  rule: one(automationRules, { fields: [automationEnrollments.ruleId], references: [automationRules.id] }),
  person: one(people, { fields: [automationEnrollments.personId], references: [people.id] }),
}));

export type AutomationRule = typeof automationRules.$inferSelect;
export type AutomationEnrollment = typeof automationEnrollments.$inferSelect;
