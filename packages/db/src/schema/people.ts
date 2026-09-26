import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { archivedAt, clinicIdColumn, primaryId, timestamps } from "./_shared";
import {
  consentPurposeEnum,
  consentSourceEnum,
  consentStatusEnum,
  contactChannelEnum,
} from "./enums";
import { branches, clinics, users } from "./tenancy";

/**
 * A person is the unique human. One person may have many inquiries over time
 * (BRD 2), so leads point at a person rather than duplicating contact details.
 *
 * Contact values are stored twice on purpose: the normalized form is what
 * matching and de-duplication use, and the original string is kept verbatim for
 * audit (PRD 5: "Keep original values for audit").
 */
export const people = pgTable(
  "people",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),

    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Whatever the source gave us when it did not separate the parts. */
    displayName: text("display_name").notNull(),

    /** Exactly as entered or received. */
    phoneRaw: text("phone_raw"),
    /** E.164 where parsing succeeded. The matching key (PRD ID-06). */
    phoneE164: text("phone_e164"),
    phoneCountry: text("phone_country"),
    /** False when the raw value could not be parsed; staff can still see it. */
    phoneValid: boolean("phone_valid").notNull().default(false),

    emailRaw: text("email_raw"),
    /** Lower-cased and trimmed. The matching key. */
    emailNormalized: text("email_normalized"),

    preferredContactMethod: contactChannelEnum("preferred_contact_method"),
    preferredLanguage: text("preferred_language"),

    /** Which branch usually sees this person. Null when it does not matter. */
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),

    /**
     * Restricted demographic fields. Hidden from practitioners and marketing
     * analysts by FIELD_VISIBILITY, and never sent to an ad platform.
     */
    dateOfBirth: date("date_of_birth"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),

    /**
     * Set when this record was merged into another. The row is kept rather than
     * deleted so the merge stays reversible and every submission it carried
     * remains traceable (BRD 7).
     */
    mergedIntoPersonId: uuid("merged_into_person_id"),
    mergedAt: timestamp("merged_at", { withTimezone: true, mode: "date" }),

    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [
    // Matching keys. Deliberately NOT unique: a possible duplicate goes to review
    // rather than being rejected at write time (PRD ID-06).
    index("people_clinic_phone_idx").on(t.clinicId, t.phoneE164),
    index("people_clinic_email_idx").on(t.clinicId, t.emailNormalized),
    index("people_clinic_created_idx").on(t.clinicId, t.createdAt),
    index("people_merged_into_idx").on(t.mergedIntoPersonId),
  ],
);

/**
 * General Notes (PRD ID-08).
 *
 * Attached to the PERSON, not a lead, so the same context is visible from every
 * inquiry that person ever makes. Internal staff context only: never exported to
 * an ad platform, never interpolated into an automated message, never logged.
 * Enforced at the point of use, and asserted in tests.
 */
export const generalNotes = pgTable(
  "general_notes",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),

    body: text("body").notNull(),
    /** Pinned notes sort first, so the thing staff must remember is seen first. */
    pinned: boolean("pinned").notNull().default(false),

    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Preserved so an archived author still reads correctly in the timeline. */
    authorLabel: text("author_label"),

    /** Edited notes keep their history in audit_events, not here. */
    editedAt: timestamp("edited_at", { withTimezone: true, mode: "date" }),
    editedByUserId: uuid("edited_by_user_id").references(() => users.id, { onDelete: "set null" }),

    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [
    index("general_notes_person_idx").on(t.personId, t.pinned, t.createdAt),
    index("general_notes_clinic_idx").on(t.clinicId),
  ],
);

/**
 * Consent ledger (PRD MSG-04).
 *
 * Append-only: every change is a new row, so the history of what someone agreed
 * to, when, and under which notice version is never overwritten. Current state
 * is the newest row for a (person, channel, purpose).
 *
 * Channel and purpose are separate dimensions on purpose. Agreeing to
 * appointment reminders by email is not agreement to marketing by WhatsApp, and
 * conflating them is how clinics end up sending things they should not.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),

    channel: contactChannelEnum("channel").notNull(),
    purpose: consentPurposeEnum("purpose").notNull(),
    status: consentStatusEnum("status").notNull(),
    source: consentSourceEnum("source").notNull(),

    /** Which privacy notice or consent wording was shown. */
    noticeVersion: text("notice_version"),
    /** Pointer to the evidence: a submission id, a recording reference, a form. */
    evidenceReference: text("evidence_reference"),
    /** The exact text the person agreed to, when the source captured it. */
    capturedText: text("captured_text"),

    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamps().createdAt,
  },
  (t) => [
    // Serves the "what is the current state" lookup that runs before every send.
    index("consent_person_channel_purpose_idx").on(t.personId, t.channel, t.purpose, t.occurredAt),
    index("consent_clinic_idx").on(t.clinicId),
  ],
);

/**
 * A reversible merge (PRD ID-06: "merge is reversible within retention window or
 * admin-audited").
 *
 * The snapshot holds exactly what was re-pointed, so an undo can put every
 * lead, note, task and appointment back where it was.
 */
export const personMerges = pgTable(
  "person_merges",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    survivingPersonId: uuid("surviving_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    mergedPersonId: uuid("merged_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** { leadIds, noteIds, taskIds, consentIds, ... } as they were before. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
    mergedAt: timestamp("merged_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    revertedAt: timestamp("reverted_at", { withTimezone: true, mode: "date" }),
    revertedByUserId: uuid("reverted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("person_merges_surviving_idx").on(t.survivingPersonId),
    uniqueIndex("person_merges_merged_active_key").on(t.mergedPersonId, t.revertedAt),
  ],
);

// --- Relations ------------------------------------------------------------

export const peopleRelations = relations(people, ({ one, many }) => ({
  clinic: one(clinics, { fields: [people.clinicId], references: [clinics.id] }),
  branch: one(branches, { fields: [people.branchId], references: [branches.id] }),
  generalNotes: many(generalNotes),
  consentRecords: many(consentRecords),
}));

export const generalNotesRelations = relations(generalNotes, ({ one }) => ({
  person: one(people, { fields: [generalNotes.personId], references: [people.id] }),
  author: one(users, { fields: [generalNotes.authorUserId], references: [users.id] }),
}));

export const consentRecordsRelations = relations(consentRecords, ({ one }) => ({
  person: one(people, { fields: [consentRecords.personId], references: [people.id] }),
}));

export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type GeneralNote = typeof generalNotes.$inferSelect;
export type ConsentRecord = typeof consentRecords.$inferSelect;
export type PersonMerge = typeof personMerges.$inferSelect;
