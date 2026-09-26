/**
 * Shared domain vocabulary. These are the single source of truth: the Drizzle
 * schema builds Postgres enums from these arrays, and the UI renders from the
 * same labels, so a new value cannot drift between layers.
 */

// --- Roles and permissions (PRD 2) ----------------------------------------

export const USER_ROLES = ["admin", "front_desk", "practitioner", "marketing_analyst"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin / owner",
  front_desk: "Front desk / counselor",
  practitioner: "Practitioner",
  marketing_analyst: "Marketing analyst",
};

export const USER_STATUSES = ["invited", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// --- Lead pipeline (PRD 4.2) ----------------------------------------------

/**
 * Stable outcome categories. Admins may rename and reorder the *stages* a
 * clinic sees, but every stage maps to one of these categories so reporting
 * and conversion-feedback mapping stay comparable across clinics.
 */
export const STAGE_CATEGORIES = [
  "new",
  "attempting_contact",
  "connected",
  "qualified",
  "consultation_booked",
  "consultation_attended",
  "converted",
  "nurture",
  "lost",
  "unqualified",
  "duplicate",
] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

/** Categories that close a lead. Closed leads receive no active nurture by default. */
export const CLOSED_STAGE_CATEGORIES: readonly StageCategory[] = [
  "converted",
  "lost",
  "unqualified",
  "duplicate",
] as const;

/** Categories that require a written reason on entry (PRD LEAD-02). */
export const REASON_REQUIRED_STAGE_CATEGORIES: readonly StageCategory[] = [
  "lost",
  "unqualified",
] as const;

/**
 * Default pipeline seeded for a new clinic, in display order.
 *
 * Six stages, on purpose. The earlier eleven-stage pipeline asked the front
 * desk to distinguish "attempting contact" from "connected" from "qualified"
 * for every inquiry, and in practice they don't — they need to know who is
 * new, who has been reached, who is booked, who came in, who paid and who is
 * gone (D-57). The retired categories stay in the enum so history and the
 * conversion-feedback mapping keep working; they are just not seeded or shown.
 */
export const DEFAULT_PIPELINE: ReadonlyArray<{
  category: StageCategory;
  name: string;
  isClosed: boolean;
}> = [
  { category: "new", name: "New", isClosed: false },
  { category: "connected", name: "Contacted", isClosed: false },
  { category: "consultation_booked", name: "Qualified", isClosed: false },
  { category: "consultation_attended", name: "Visited", isClosed: false },
  { category: "converted", name: "Won", isClosed: true },
  { category: "lost", name: "Lost", isClosed: true },
];

/**
 * One-line explanation shown under each stage name, so nobody has to guess
 * what a stage means. "Qualified" in particular: at this clinic a lead counts
 * as qualified when they book (D-63), which is also the moment the CRM reports
 * a qualified lead back to the ad platforms.
 */
export const STAGE_HINTS: Partial<Record<StageCategory, string>> = {
  new: "Just came in",
  connected: "You've spoken to them",
  consultation_booked: "Booked an appointment",
  consultation_attended: "Came to their appointment",
  converted: "Became a paying client",
  lost: "Not going ahead",
};

/**
 * Categories from the original pipeline that are no longer used, and where a
 * lead sitting in one is moved to. Applied by packages/db/sql/930_simplify_pipeline.sql.
 */
export const RETIRED_STAGE_CATEGORIES: Readonly<Partial<Record<StageCategory, StageCategory>>> = {
  attempting_contact: "connected",
  qualified: "connected",
  nurture: "connected",
  unqualified: "lost",
  duplicate: "lost",
};

// --- Automations (PRD 4.4, MSG-03, MSG-06) ------------------------------

/** What starts an automation. Kept to events a clinic actually thinks in. */
export const AUTOMATION_TRIGGERS = [
  "lead_created",
  "stage_changed",
  "appointment_booked",
  "appointment_upcoming",
  "appointment_attended",
  "appointment_no_show",
  "appointment_canceled",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_STATUSES = ["draft", "active", "paused"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/** One person's run through one automation. */
export const ENROLLMENT_STATES = ["active", "completed", "stopped", "failed"] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/**
 * Configurable reasons to stop a run early (PRD MSG-06). Opt-out is not in
 * this list because it is not optional: the send gate blocks an opted-out
 * contact on every send, whatever the automation says.
 */
export const AUTOMATION_STOP_CONDITIONS = ["replied", "booked", "converted", "closed"] as const;
export type AutomationStopCondition = (typeof AUTOMATION_STOP_CONDITIONS)[number];

// --- Sources and attribution (PRD 4.5) ------------------------------------

export const LEAD_SOURCES = [
  "walk_in",
  "phone",
  "website_form",
  "csv_import",
  "meta_lead_ad",
  "google_lead_form",
  "whatsapp_ad",
  "whatsapp_organic",
  "referral",
  "manual",
  "unknown",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  walk_in: "Walk-in",
  phone: "Phone",
  website_form: "Website form",
  csv_import: "CSV import",
  meta_lead_ad: "Meta lead ad",
  google_lead_form: "Google lead form",
  whatsapp_ad: "WhatsApp ad",
  whatsapp_organic: "WhatsApp organic",
  referral: "Referral",
  manual: "Manual entry",
  unknown: "Unknown",
};

/** External platforms that can deliver a source submission. */
export const SOURCE_PLATFORMS = [
  "meta",
  "google",
  "whatsapp",
  "website",
  "csv",
  "internal",
] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export const INGEST_STATUSES = [
  "received",
  "processing",
  "processed",
  "failed",
  "dead_letter",
  "duplicate",
] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

// --- Tasks and activity (PRD 4.2) -----------------------------------------

export const TASK_STATUSES = ["open", "snoozed", "completed", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Outcome required when a task is completed (PRD LEAD-05). */
export const TASK_OUTCOMES = [
  "connected",
  "no_answer",
  "left_voicemail",
  "invalid_contact",
  "not_interested",
  "booked",
  "rescheduled",
  "other",
] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const ACTIVITY_TYPES = [
  "note",
  "call",
  "email_sent",
  "email_received",
  "whatsapp_sent",
  "whatsapp_received",
  "stage_change",
  "assignment_change",
  "task_created",
  "task_completed",
  "appointment_created",
  "appointment_changed",
  "consent_change",
  "automation_event",
  "source_submission",
  "merge",
  "conversion_feedback",
  "system",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const CONTACT_ATTEMPT_OUTCOMES = [
  "attempted",
  "connected",
  "no_answer",
  "invalid_contact",
] as const;
export type ContactAttemptOutcome = (typeof CONTACT_ATTEMPT_OUTCOMES)[number];

// --- Appointments (PRD 4.3) -----------------------------------------------

/** Appointment status is deliberately independent of lead stage (PRD CAL-04). */
export const APPOINTMENT_STATUSES = [
  "scheduled",
  "confirmed",
  "attended",
  "no_show",
  "canceled",
  "rescheduled",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

// --- Contact, consent, messaging (PRD 4.4) --------------------------------

export const CONTACT_CHANNELS = ["email", "whatsapp", "phone", "sms"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** Channels this release can actually send on. */
export const SENDABLE_CHANNELS = ["email", "whatsapp"] as const;
export type SendableChannel = (typeof SENDABLE_CHANNELS)[number];

/**
 * Consent is tracked per channel AND per purpose. Operational appointment
 * messages and promotional nurture are never covered by one flag.
 */
export const CONSENT_PURPOSES = ["operational", "promotional"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_STATUSES = ["granted", "denied", "withdrawn", "unknown"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const CONSENT_SOURCES = [
  "web_form",
  "walk_in_form",
  "verbal_staff_recorded",
  "whatsapp_inbound",
  "ad_platform_form",
  "csv_import",
  "unsubscribe_link",
  "staff_override",
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/**
 * Template classification. Drives the CAN-SPAM guardrail: a promotional
 * template must carry sender identity, postal address and an unsubscribe link,
 * and cannot be sent without `promotional` consent.
 */
export const TEMPLATE_CLASSIFICATIONS = ["operational", "promotional"] as const;
export type TemplateClassification = (typeof TEMPLATE_CLASSIFICATIONS)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** Full delivery lifecycle shown in the message log (PRD MSG-07). */
export const MESSAGE_DELIVERY_STATES = [
  "draft",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "bounced",
  "failed",
  "canceled",
  "suppressed",
] as const;
export type MessageDeliveryState = (typeof MESSAGE_DELIVERY_STATES)[number];

/** Why a send was blocked. Every suppression records one of these. */
export const SUPPRESSION_REASONS = [
  "no_consent",
  "opted_out",
  "frequency_cap",
  "quiet_hours",
  "outside_service_window",
  "template_not_approved",
  "missing_contact_detail",
  "lead_closed",
  "appointment_changed",
  "stop_condition_met",
  "global_sending_disabled",
  "provider_paused",
  "duplicate_idempotency_key",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

// --- WhatsApp (PRD 4.4a) --------------------------------------------------

export const WHATSAPP_MESSAGE_TYPES = [
  "text",
  "template",
  "image",
  "document",
  "audio",
  "video",
  "sticker",
  "location",
  "contacts",
  "interactive",
  "unsupported",
] as const;
export type WhatsAppMessageType = (typeof WHATSAPP_MESSAGE_TYPES)[number];

export const CONVERSATION_STATUSES = ["open", "pending", "resolved", "snoozed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const WHATSAPP_TEMPLATE_STATUSES = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "paused",
  "disabled",
] as const;
export type WhatsAppTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUSES)[number];

/**
 * Meta permits a free-form reply only within 24 hours of the customer's last
 * message. Outside it, only an approved template may be sent (PRD WA-06).
 */
export const WHATSAPP_SERVICE_WINDOW_HOURS = 24;

// --- Integrations (PRD 4.5) -----------------------------------------------

export const INTEGRATION_PROVIDERS = [
  "meta_lead_ads",
  "meta_conversions_api",
  "whatsapp_cloud",
  "google_lead_forms",
  "google_data_manager",
  "email",
  "calendar",
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_HEALTH_STATES = [
  "not_configured",
  "connecting",
  "healthy",
  "degraded",
  "disconnected",
  "error",
] as const;
export type IntegrationHealthState = (typeof INTEGRATION_HEALTH_STATES)[number];

// --- Conversion feedback (PRD 4.5a) ---------------------------------------

export const FEEDBACK_DESTINATIONS = ["meta", "google"] as const;
export type FeedbackDestination = (typeof FEEDBACK_DESTINATIONS)[number];

/** CRM milestones that may be mapped to an ad-platform event. */
export const FEEDBACK_MILESTONES = [
  "qualified",
  "consultation_booked",
  "consultation_attended",
  "converted",
] as const;
export type FeedbackMilestone = (typeof FEEDBACK_MILESTONES)[number];

export const FEEDBACK_EVENT_STATES = [
  "candidate",
  "blocked",
  "queued",
  "sending",
  "sent",
  "accepted",
  "rejected",
  "unmatched",
  "canceled",
] as const;
export type FeedbackEventState = (typeof FEEDBACK_EVENT_STATES)[number];

/**
 * Identifiers the CRM may ever transmit. Anything not listed here is denied by
 * the allowlist gate. Deliberately excludes hashed email/phone: Google's
 * customer-data policy forbids measuring health or medical conversions with
 * enhanced conversions, so we never upload contact identifiers by default.
 */
export const FEEDBACK_MATCH_KEYS = [
  "meta_lead_id",
  "meta_whatsapp_referral_id",
  "google_click_id",
  "google_lead_id",
] as const;
export type FeedbackMatchKey = (typeof FEEDBACK_MATCH_KEYS)[number];

export const FEEDBACK_ELIGIBILITY_STATES = [
  "unreviewed",
  "blocked_by_policy",
  "pending_clinic_approval",
  "approved_test_only",
  "approved_production",
] as const;
export type FeedbackEligibilityState = (typeof FEEDBACK_ELIGIBILITY_STATES)[number];

// --- Audit (PRD 4.6) ------------------------------------------------------

export const AUDIT_ACTIONS = [
  "login_success",
  "login_failure",
  "logout",
  "password_reset_requested",
  "password_reset_completed",
  "mfa_enabled",
  "mfa_disabled",
  "user_invited",
  "user_role_changed",
  "user_suspended",
  "record_created",
  "record_updated",
  "record_deleted",
  "sensitive_record_viewed",
  "note_edited",
  "note_archived",
  "person_merged",
  "person_merge_reverted",
  "consent_changed",
  "export_generated",
  "automation_rule_changed",
  "template_changed",
  "integration_connected",
  "integration_disconnected",
  "integration_credentials_revoked",
  "feedback_mapping_changed",
  "feedback_paused",
  "settings_changed",
  "event_replayed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
