import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { archivedAt, clinicIdColumn, primaryId, timestamps } from "./_shared";
import {
  activityTypeEnum,
  ingestStatusEnum,
  leadSourceEnum,
  sourcePlatformEnum,
  taskOutcomeEnum,
  taskPriorityEnum,
  taskStatusEnum,
} from "./enums";
import { branches, clinics, pipelineStages, users } from "./tenancy";
import { people } from "./people";

/**
 * Every inbound submission, preserved separately from the person and the lead
 * (PRD ID-07). Nothing here is ever overwritten: this table is the evidence of
 * what a provider actually sent and when.
 *
 * The unique index on (clinic, platform, external_id) is the idempotency
 * backbone for the whole ingest pipeline. A redelivered webhook violates it and
 * is recorded as a duplicate rather than creating a second lead.
 */
export const sourceSubmissions = pgTable(
  "source_submissions",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),

    platform: sourcePlatformEnum("platform").notNull(),
    /** The provider's own id. Null for walk-ins and other internal entries. */
    externalId: text("external_id"),
    /** The narrower business-facing source shown in reporting. */
    source: leadSourceEnum("source").notNull(),

    /** When the prospect submitted, per the provider. May predate receivedAt. */
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
    /** When we received it. Always set. */
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),

    // --- Attribution (PRD INT-05). Every field stays null when not provided;
    // a missing value is never invented.
    accountId: text("account_id"),
    campaignId: text("campaign_id"),
    campaignName: text("campaign_name"),
    adsetId: text("adset_id"),
    adId: text("ad_id"),
    formId: text("form_id"),
    formName: text("form_name"),
    /** Google click id (gclid) or equivalent, when the provider supplies one. */
    clickId: text("click_id"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    /** WhatsApp click-to-chat referral id, when the metadata reliably has one. */
    referralId: text("referral_id"),

    /** Mapped, non-sensitive fields. The raw payload lives encrypted elsewhere. */
    normalizedFields: jsonb("normalized_fields").$type<Record<string, unknown>>().notNull().default({}),
    rawPayloadId: uuid("raw_payload_id"),
    payloadFingerprint: text("payload_fingerprint"),

    /** Providers flag test submissions; they must not pollute reporting (INT-03). */
    isTest: boolean("is_test").notNull().default(false),

    ingestStatus: ingestStatusEnum("ingest_status").notNull().default("received"),
    ingestError: text("ingest_error"),
    attempts: integer("attempts").notNull().default(0),
    correlationId: text("correlation_id"),

    /** Filled once normalization matches or creates them. */
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    leadId: uuid("lead_id"),

    ...timestamps(),
  },
  (t) => [
    // Partial: internal entries have no external id and must not collide.
    uniqueIndex("source_submissions_external_key")
      .on(t.clinicId, t.platform, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index("source_submissions_clinic_received_idx").on(t.clinicId, t.receivedAt),
    index("source_submissions_status_idx").on(t.clinicId, t.ingestStatus),
    index("source_submissions_person_idx").on(t.personId),
  ],
);

/**
 * Raw third-party payloads, encrypted and kept out of ordinary CRM queries
 * (PRD 5). Separate table so access can be restricted and retention applied
 * independently of the records staff work with every day.
 */
export const rawPayloads = pgTable(
  "raw_payloads",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    platform: sourcePlatformEnum("platform").notNull(),
    /** AES-256-GCM via encryptForClinic. Never returned by a list endpoint. */
    encryptedPayload: text("encrypted_payload").notNull(),
    fingerprint: text("fingerprint").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** Deleted by a retention job once this passes. */
    retentionUntil: timestamp("retention_until", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("raw_payloads_clinic_received_idx").on(t.clinicId, t.receivedAt),
    index("raw_payloads_retention_idx").on(t.retentionUntil),
  ],
);

/**
 * A lead is one inquiry/opportunity. One person may have several over time, and
 * each keeps its own source — which is what makes "source of the converted
 * inquiry" attribution possible (BRD 8).
 */
export const leads = pgTable(
  "leads",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** The submission that opened this lead, when it came from one. */
    sourceSubmissionId: uuid("source_submission_id").references(() => sourceSubmissions.id, {
      onDelete: "set null",
    }),

    /** Immutable after ingestion (BRD 7). */
    source: leadSourceEnum("source").notNull(),
    /**
     * A staff-corrected source for reporting, when the original was wrong. The
     * original is never edited; this sits alongside it with an audit record.
     */
    reportingSource: leadSourceEnum("reporting_source"),

    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStages.id, { onDelete: "restrict" }),
    /** Null means the unassigned queue (PRD LEAD-03). */
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),

    serviceInterest: text("service_interest"),
    /** Free-text detail from the inquiry itself, distinct from General Notes. */
    inquiryNote: text("inquiry_note"),

    /** Milestone timestamps. These drive the funnel and conversion feedback. */
    firstContactedAt: timestamp("first_contacted_at", { withTimezone: true, mode: "date" }),
    /**
     * Response-time SLA (D-73). `first_response_at` is the first time anyone on
     * the team did something with the lead — a logged call attempt, a message,
     * moving it out of New. `sla_due_at` is fixed at creation from the clinic's
     * target; `sla_breached_at` is stamped once by the worker when it passes.
     */
    firstResponseAt: timestamp("first_response_at", { withTimezone: true, mode: "date" }),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true, mode: "date" }),
    slaBreachedAt: timestamp("sla_breached_at", { withTimezone: true, mode: "date" }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true, mode: "date" }),
    qualifiedByUserId: uuid("qualified_by_user_id").references(() => users.id, { onDelete: "set null" }),
    bookedAt: timestamp("booked_at", { withTimezone: true, mode: "date" }),
    attendedAt: timestamp("attended_at", { withTimezone: true, mode: "date" }),
    convertedAt: timestamp("converted_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    /** Required when entering Lost or Unqualified (PRD LEAD-02). */
    lossReason: text("loss_reason"),

    /** Marked when the provider said this was a test submission (PRD INT-03). */
    isTest: boolean("is_test").notNull().default(false),

    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [
    index("leads_clinic_stage_idx").on(t.clinicId, t.stageId),
    index("leads_clinic_owner_idx").on(t.clinicId, t.ownerUserId),
    // The worker's SLA sweep: open, unanswered, due.
    index("leads_sla_due_idx").on(t.slaDueAt).where(sql`${t.firstResponseAt} is null and ${t.slaBreachedAt} is null`),
    index("leads_person_idx").on(t.personId),
    index("leads_clinic_created_idx").on(t.clinicId, t.createdAt),
    index("leads_clinic_source_idx").on(t.clinicId, t.source),
  ],
);

/** Every stage transition, with who and why (PRD LEAD-02). */
export const leadStageEvents = pgTable(
  "lead_stage_events",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    fromStageId: uuid("from_stage_id").references(() => pipelineStages.id, { onDelete: "set null" }),
    toStageId: uuid("to_stage_id")
      .notNull()
      .references(() => pipelineStages.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Mandatory for Lost and Unqualified. */
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("lead_stage_events_lead_idx").on(t.leadId, t.occurredAt)],
);

/**
 * The unified timeline (PRD LEAD-04). Source submissions, notes, calls, emails,
 * WhatsApp messages, tasks, appointments and automation events all land here so
 * one query renders the lead history in timestamp order.
 */
export const activities = pgTable(
  "activities",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),

    type: activityTypeEnum("type").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    /** Short human summary. Safe to show in a list. */
    summary: text("summary").notNull(),
    /** Longer detail, e.g. a contact-attempt note. May be sensitive. */
    body: text("body"),
    outcome: text("outcome"),

    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label"),
    /** Points at the row this activity describes, e.g. a task or appointment. */
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamps().createdAt,
  },
  (t) => [
    index("activities_lead_idx").on(t.leadId, t.occurredAt),
    index("activities_person_idx").on(t.personId, t.occurredAt),
    index("activities_clinic_type_idx").on(t.clinicId, t.type),
  ],
);

/** Follow-up work (PRD LEAD-05). Completion requires an outcome. */
export const tasks = pgTable(
  "tasks",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    detail: text("detail"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Stored UTC; due/overdue views compute in the clinic timezone. */
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull(),
    status: taskStatusEnum("status").notNull().default("open"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),

    outcome: taskOutcomeEnum("outcome"),
    outcomeNote: text("outcome_note"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Snoozing requires a new due time, which is written back to dueAt. */
    snoozedFrom: timestamp("snoozed_from", { withTimezone: true, mode: "date" }),

    /** Set when an automation created this rather than a person. */
    createdByRuleId: uuid("created_by_rule_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),

    ...timestamps(),
  },
  (t) => [
    // Serves the "my due and overdue work" view that opens every shift.
    index("tasks_owner_due_idx").on(t.clinicId, t.ownerUserId, t.status, t.dueAt),
    index("tasks_lead_idx").on(t.leadId),
    index("tasks_clinic_due_idx").on(t.clinicId, t.dueAt),
  ],
);

// --- Relations ------------------------------------------------------------

export const sourceSubmissionsRelations = relations(sourceSubmissions, ({ one }) => ({
  person: one(people, { fields: [sourceSubmissions.personId], references: [people.id] }),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  person: one(people, { fields: [leads.personId], references: [people.id] }),
  stage: one(pipelineStages, { fields: [leads.stageId], references: [pipelineStages.id] }),
  owner: one(users, { fields: [leads.ownerUserId], references: [users.id] }),
  submission: one(sourceSubmissions, {
    fields: [leads.sourceSubmissionId],
    references: [sourceSubmissions.id],
  }),
  stageEvents: many(leadStageEvents),
  activities: many(activities),
  tasks: many(tasks),
}));

export const leadStageEventsRelations = relations(leadStageEvents, ({ one }) => ({
  lead: one(leads, { fields: [leadStageEvents.leadId], references: [leads.id] }),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  lead: one(leads, { fields: [activities.leadId], references: [leads.id] }),
  person: one(people, { fields: [activities.personId], references: [people.id] }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  lead: one(leads, { fields: [tasks.leadId], references: [leads.id] }),
  owner: one(users, { fields: [tasks.ownerUserId], references: [users.id] }),
}));

export type SourceSubmission = typeof sourceSubmissions.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadStageEvent = typeof leadStageEvents.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type Task = typeof tasks.$inferSelect;
