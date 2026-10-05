import { relations } from "drizzle-orm";
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
import type { Capability } from "@skincrm/contracts";
import { archivedAt, clinicIdColumn, primaryId, timestamps } from "./_shared";
import { stageCategoryEnum, userRoleEnum, userStatusEnum } from "./enums";

/**
 * A clinic is the tenant boundary. Everything else in the schema carries its id.
 * Deleting a clinic is an offline operation, never an API call.
 */
export const clinics = pgTable(
  "clinics",
  {
    id: primaryId(),
    name: text("name").notNull(),
    /** URL-safe identifier used for the clinic's sign-in page and webhook paths. */
    slug: text("slug").notNull(),
    /** IANA timezone. All clinic-local date maths and display use it (PRD SET-01). */
    timezone: text("timezone").notNull().default("America/New_York"),
    /** ISO 3166-1 alpha-2. Drives default phone normalization. */
    country: text("country").notNull().default("US"),
    /** Postal address, required on promotional email under CAN-SPAM. */
    postalAddress: text("postal_address"),
    supportEmail: text("support_email"),
    /** Verified sending domain for this clinic's email (PRD MSG-01). */
    sendingDomain: text("sending_domain"),
    /**
     * Key for the public website lead endpoint (PRD ID-05), stored as a SHA-256
     * digest like every other credential here — the plaintext is shown once
     * when generated and never again.
     */
    websiteFormKeyHash: text("website_form_key_hash"),
    /** Minutes a new lead may sit uncontacted before a follow-up task is due. */
    firstContactSlaMinutes: integer("first_contact_sla_minutes").notNull().default(60),
    /** Quiet hours in clinic-local time; automated sends wait until the window ends. */
    quietHoursStart: text("quiet_hours_start").notNull().default("21:00"),
    quietHoursEnd: text("quiet_hours_end").notNull().default("08:00"),
    /**
     * Clinic-level acknowledgements. Promotional sending stays off until the
     * clinic's privacy lead signs off on copy and legal basis (PRD 4.4).
     */
    promotionalSendingApproved: boolean("promotional_sending_approved").notNull().default(false),
    /** Public booking page at /book/{slug} (PRD CAL-06). Off until an admin turns it on. */
    onlineBookingEnabled: boolean("online_booking_enabled").notNull().default(false),
    /** Patients can move or cancel online until this many hours before the start. */
    bookingChangeCutoffHours: integer("booking_change_cutoff_hours").notNull().default(24),
    promotionalSendingApprovedAt: timestamp("promotional_sending_approved_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Main phone number patients see in messages ({{clinic.phone}}). */
    phone: text("phone"),
    website: text("website"),
    /**
     * The clinic's logo, stored in the database (base64) rather than a file
     * store: it's small (≤ 512 KB, checked on upload), there is exactly one,
     * and it then lives in the same backups as everything else.
     */
    logoData: text("logo_data"),
    logoMime: text("logo_mime"),
    logoUpdatedAt: timestamp("logo_updated_at", { withTimezone: true, mode: "date" }),
    /** Minutes the team has to respond to a new lead (D-73). 0 turns the SLA off. */
    firstResponseSlaMinutes: integer("first_response_sla_minutes").notNull().default(60),
    /** When the SLA is missed: a high-priority task, and an email to owner + admins. */
    slaEscalationEnabled: boolean("sla_escalation_enabled").notNull().default(true),
    /** Set once the clinic confirms its HIPAA status; gates real-data features. */
    hipaaStatus: text("hipaa_status").notNull().default("undetermined"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [
    uniqueIndex("clinics_slug_key").on(t.slug),
    uniqueIndex("clinics_website_form_key_idx").on(t.websiteFormKeyHash),
  ],
);

export const branches = pgTable(
  "branches",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Overrides the clinic timezone when a branch sits in another zone. */
    timezone: text("timezone"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    phone: text("phone"),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [index("branches_clinic_idx").on(t.clinicId)],
);

export const users = pgTable(
  "users",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    /** Argon2id hash. Null while an invite is outstanding. */
    passwordHash: text("password_hash"),
    role: userRoleEnum("role").notNull(),
    status: userStatusEnum("status").notNull().default("invited"),
    /** Base32 TOTP secret, encrypted at rest. Required for admins (PRD ID-01). */
    mfaSecretEncrypted: text("mfa_secret_encrypted"),
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true, mode: "date" }),
    /** Extra capabilities beyond the role, from GRANTABLE_CAPABILITIES. */
    grantedCapabilities: jsonb("granted_capabilities").$type<Capability[]>().notNull().default([]),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    /** Set on repeated failures; login is refused until it passes. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    /**
     * Bumped to revoke every existing session for this user at once (password
     * change, role change, suspension). Sessions carry the value they were
     * issued with and are rejected when it no longer matches.
     */
    sessionEpoch: integer("session_epoch").notNull().default(0),
    /** Notification types this person has switched off; everything else is on. */
    mutedNotifications: jsonb("muted_notifications").$type<string[]>().notNull().default([]),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [
    // Email is unique per clinic, not globally: the same person may work at two
    // clinics on the same platform.
    uniqueIndex("users_clinic_email_key").on(t.clinicId, t.email),
    index("users_clinic_role_idx").on(t.clinicId, t.role),
  ],
);

/** Branch membership. No rows means the user may act in every branch. */
export const userBranches = pgTable(
  "user_branches",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    createdAt: timestamps().createdAt,
  },
  (t) => [uniqueIndex("user_branches_user_branch_key").on(t.userId, t.branchId)],
);

/**
 * Server-side sessions. The cookie holds an opaque random id; only its hash is
 * stored, so a database read cannot be replayed as a login.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    sessionEpoch: integer("session_epoch").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Sliding-window idle timeout; refreshed on use up to `expiresAt`. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamps().createdAt,
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Single-use tokens for invites, password resets and self-service links. One
 * table keeps expiry and single-use enforcement in one place.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(), // invite | password_reset | email_verify
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamps().createdAt,
  },
  (t) => [
    uniqueIndex("auth_tokens_token_hash_key").on(t.tokenHash),
    index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose),
  ],
);

/** Hashed one-time MFA recovery codes. Each row is consumed on use. */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamps().createdAt,
  },
  (t) => [index("mfa_recovery_codes_user_idx").on(t.userId)],
);

/**
 * The clinic's pipeline. Admins rename and reorder these, but `category` stays
 * fixed so reporting and conversion-feedback mapping remain comparable
 * (PRD 4.2: "system outcome categories remain stable for reporting").
 */
export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    category: stageCategoryEnum("category").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    isClosed: boolean("is_closed").notNull().default(false),
    /** Lost and Unqualified require a written reason on entry (PRD LEAD-02). */
    requiresReason: boolean("requires_reason").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    // One stage per category per clinic keeps the category → stage lookup
    // unambiguous for automations and reporting.
    uniqueIndex("pipeline_stages_clinic_category_key").on(t.clinicId, t.category),
    index("pipeline_stages_clinic_position_idx").on(t.clinicId, t.position),
  ],
);

/**
 * Append-only audit trail (PRD AUD-01). No update or delete policy is granted
 * to the application role, so a compromised app cannot rewrite history.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    /** Null for unauthenticated events such as a failed login. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Preserved separately so the entry still reads correctly after a user is deleted. */
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    /**
     * Redacted before/after summary. Never stores note bodies, message bodies or
     * full contact details (PRD 8).
     */
    changeSummary: jsonb("change_summary").$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    correlationId: text("correlation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_clinic_occurred_idx").on(t.clinicId, t.occurredAt),
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_actor_idx").on(t.actorUserId),
  ],
);

// --- Relations ------------------------------------------------------------

export const clinicsRelations = relations(clinics, ({ many }) => ({
  branches: many(branches),
  users: many(users),
  pipelineStages: many(pipelineStages),
}));

export const branchesRelations = relations(branches, ({ one, many }) => ({
  clinic: one(clinics, { fields: [branches.clinicId], references: [clinics.id] }),
  userBranches: many(userBranches),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  clinic: one(clinics, { fields: [users.clinicId], references: [clinics.id] }),
  branches: many(userBranches),
  sessions: many(sessions),
}));

export const userBranchesRelations = relations(userBranches, ({ one }) => ({
  user: one(users, { fields: [userBranches.userId], references: [users.id] }),
  branch: one(branches, { fields: [userBranches.branchId], references: [branches.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const pipelineStagesRelations = relations(pipelineStages, ({ one }) => ({
  clinic: one(clinics, { fields: [pipelineStages.clinicId], references: [clinics.id] }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  actor: one(users, { fields: [auditEvents.actorUserId], references: [users.id] }),
}));

// Convenience row types used across the API layer.
export type Clinic = typeof clinics.$inferSelect;
export type NewClinic = typeof clinics.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type AuthToken = typeof authTokens.$inferSelect;
export type PipelineStage = typeof pipelineStages.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

export const TENANT_TABLES_TENANCY = [
  "branches",
  "users",
  "user_branches",
  "sessions",
  "auth_tokens",
  "mfa_recovery_codes",
  "pipeline_stages",
  "audit_events",
] as const;
