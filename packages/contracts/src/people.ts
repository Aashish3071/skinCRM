import { z } from "zod";
import {
  isoDate,
  isoDateTime,
  optionalShortText,
  queryBoolean,
  uuidSchema,
} from "./common";
import { CONSENT_PURPOSES, CONSENT_SOURCES, CONSENT_STATUSES, CONTACT_CHANNELS } from "./enums";
import {
  optionalEmailField,
  optionalNameField,
  optionalPhoneField,
  optionalPlaceField,
  optionalPostalCodeField,
} from "./contact";

/**
 * Phone and email are both optional individually, but at least one is required
 * (PRD ID-02). A person with neither cannot be contacted or matched, which makes
 * them useless to the workflow and a magnet for duplicates.
 */
const contactRefinement = <T extends { phone?: string | null; email?: string | null }>(value: T) =>
  Boolean(value.phone?.trim()) || Boolean(value.email?.trim());

/** Typed by staff, so strict (see contact.ts). Ingestion paths do not use these. */
const contactFields = {
  /** Phone characters only; must be a real number for the clinic's country (checked by the API). */
  phone: optionalPhoneField,
  email: optionalEmailField,
};

const nameFields = {
  firstName: optionalNameField(120),
  lastName: optionalNameField(120),
};

/** Born in the past, and not implausibly long ago. */
const dateOfBirthField = isoDate.nullish().refine(
  (value) => !value || (value <= new Date().toISOString().slice(0, 10) && value >= "1900-01-01"),
  "Enter a date of birth in the past",
);

const profileFields = {
  preferredContactMethod: z.enum(CONTACT_CHANNELS).nullish(),
  preferredLanguage: optionalPlaceField(60),
  branchId: uuidSchema.nullish(),
  dateOfBirth: dateOfBirthField,
  addressLine1: optionalShortText(200),
  addressLine2: optionalShortText(200),
  city: optionalPlaceField(120),
  region: optionalPlaceField(120),
  postalCode: optionalPostalCodeField,
};

export const createPersonSchema = z
  .object({
    ...nameFields,
    ...contactFields,
    ...profileFields,
    /**
     * Proceed even though the server found a possible duplicate. The UI sets
     * this only after showing the candidates and the user choosing "create
     * anyway", so a duplicate is always a deliberate act (PRD ID-06).
     */
    allowDuplicate: z.boolean().default(false),
  })
  .refine(contactRefinement, {
    message: "Give at least a phone number or an email address",
    path: ["phone"],
  });
export type CreatePerson = z.infer<typeof createPersonSchema>;

/**
 * Editing: phone and email are checked by the API only when they change, so a
 * patient imported with an unreadable number can still have their city fixed.
 */
export const updatePersonSchema = z.object({
  ...nameFields,
  phone: optionalShortText(40),
  email: optionalShortText(320),
  ...profileFields,
});
export type UpdatePerson = z.infer<typeof updatePersonSchema>;

export const personSchema = z.object({
  id: uuidSchema,
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  phoneE164: z.string().nullable(),
  phoneValid: z.boolean(),
  email: z.string().nullable(),
  preferredContactMethod: z.enum(CONTACT_CHANNELS).nullable(),
  preferredLanguage: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  dateOfBirth: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  /** Set when this record was merged away; the UI redirects to the survivor. */
  mergedIntoPersonId: uuidSchema.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type PersonDto = z.infer<typeof personSchema>;

export const listPeopleQuerySchema = z.object({
  /** Matches name, phone or email. */
  search: optionalShortText(200),
  branchId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  /** Include records that were merged away. Off by default. */
  includeMerged: queryBoolean(false),
});
export type ListPeopleQuery = z.infer<typeof listPeopleQuerySchema>;

// --- Duplicate detection (PRD ID-06) --------------------------------------

export const DUPLICATE_MATCH_REASONS = ["phone", "email", "name_and_branch"] as const;
export type DuplicateMatchReason = (typeof DUPLICATE_MATCH_REASONS)[number];

export const duplicateCandidateSchema = z.object({
  person: personSchema,
  /** Why the server thinks these are the same human. */
  reasons: z.array(z.enum(DUPLICATE_MATCH_REASONS)),
  /** `exact` on a normalized phone or email; `possible` on a weaker signal. */
  confidence: z.enum(["exact", "possible"]),
  leadCount: z.number().int().nonnegative(),
});
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;

/** 409 body when a create would produce a duplicate and the caller did not opt in. */
export const duplicateConflictSchema = z.object({
  error: z.object({
    code: z.literal("duplicate_person"),
    message: z.string(),
    correlationId: z.string().optional(),
  }),
  candidates: z.array(duplicateCandidateSchema),
});

export const mergePeopleSchema = z.object({
  /** The record to fold in. Its data moves to the person in the URL. */
  mergedPersonId: uuidSchema,
  /** Recorded on the merge for the audit trail. */
  reason: optionalShortText(500),
});
export type MergePeople = z.infer<typeof mergePeopleSchema>;

// --- General Notes (PRD ID-08) --------------------------------------------

export const createNoteSchema = z.object({
  body: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1, "Write something first").max(10_000)),
  pinned: z.boolean().default(false),
});
export type CreateNote = z.infer<typeof createNoteSchema>;

export const updateNoteSchema = z.object({
  body: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1).max(10_000))
    .optional(),
  pinned: z.boolean().optional(),
});
export type UpdateNote = z.infer<typeof updateNoteSchema>;

export const noteSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  body: z.string(),
  pinned: z.boolean(),
  authorLabel: z.string().nullable(),
  authorUserId: uuidSchema.nullable(),
  createdAt: isoDateTime,
  editedAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
});
export type NoteDto = z.infer<typeof noteSchema>;

// --- Consent (PRD MSG-04) -------------------------------------------------

export const recordConsentSchema = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  purpose: z.enum(CONSENT_PURPOSES),
  status: z.enum(CONSENT_STATUSES),
  source: z.enum(CONSENT_SOURCES),
  noticeVersion: optionalShortText(60),
  evidenceReference: optionalShortText(500),
  capturedText: optionalShortText(4000),
});
export type RecordConsent = z.infer<typeof recordConsentSchema>;

export const consentStateSchema = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  purpose: z.enum(CONSENT_PURPOSES),
  status: z.enum(CONSENT_STATUSES),
  source: z.enum(CONSENT_SOURCES),
  noticeVersion: z.string().nullable(),
  occurredAt: isoDateTime,
  recordedByUserId: uuidSchema.nullable(),
});
export type ConsentState = z.infer<typeof consentStateSchema>;

/**
 * Whether a send is permitted right now.
 *
 * `granted` is required for promotional. Operational messages may also proceed
 * on `unknown` **only** where the clinic has an approved lawful basis, which is
 * a clinic-level setting rather than something this function can assume — so the
 * default here is the strict reading and the caller must opt in.
 */
export function isSendPermitted(
  state: ConsentState | undefined,
  options: { allowUnknownForOperational?: boolean } = {},
): boolean {
  if (!state) return false;
  if (state.status === "granted") return true;
  if (state.status === "unknown" && state.purpose === "operational") {
    return options.allowUnknownForOperational === true;
  }
  return false;
}

export const shortNameFor = (person: { firstName?: string | null; displayName: string }): string =>
  person.firstName?.trim() || person.displayName.split(" ")[0] || person.displayName;
