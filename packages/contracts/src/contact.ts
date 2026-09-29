import { z } from "zod";
import { optionalShortText, shortText } from "./common";

/**
 * Contact-field rules, shared by every form and the API (D-89).
 *
 * Two policies, on purpose:
 *
 *  - **Typed by staff** (Add lead, Edit patient, clinic profile, settings):
 *    strict. A phone is phone characters only and must be a real number; an
 *    email must be a whole address; names have no digits. The person typing
 *    can fix it on the spot.
 *  - **Arriving from outside** (website form, CSV, Meta, Google, WhatsApp):
 *    forgiving. The lead is never dropped over a messy detail — an unreadable
 *    phone is kept as written and flagged; an unusable email is moved into the
 *    inquiry note instead of being stored as an address we would send to.
 *
 * Digits are fine inside an email address (jane.doe85@gmail.com); what makes
 * an address invalid is its shape, not the characters.
 */

const emailShape = z.string().email();

export function isValidEmail(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 0 && v.length <= 320 && emailShape.safeParse(v).success;
}

/** Characters a phone number may contain as typed: digits, space, + ( ) - . */
export const PHONE_CHARACTERS = /^[+\d\s().-]*$/;

/** Strip anything that can't be part of a phone number (used live in inputs). */
export function sanitizePhoneInput(value: string): string {
  const cleaned = value.replace(/[^+\d\s().-]/g, "");
  // A plus sign only makes sense at the start.
  return cleaned.replace(/(?!^)\+/g, "");
}

export function phoneShapeProblem(value: string): string | null {
  if (!PHONE_CHARACTERS.test(value)) return "A phone number can only contain digits, spaces, +, -, ( and ).";
  const digits = value.replace(/\D/g, "").length;
  if (digits < 7) return "That phone number is too short.";
  if (digits > 15) return "That phone number is too long.";
  return null;
}

/** A person's or staff member's name: letters, spaces, ' - . — no digits or @. */
export function nameProblem(value: string): string | null {
  if (/\d/.test(value)) return "Names can't contain numbers.";
  if (/[@<>{}[\]\\/|#$%^*=+_~`"]/.test(value)) return "Names can only contain letters, spaces, apostrophes, hyphens and full stops.";
  if (!/\p{L}/u.test(value)) return "Enter a name with letters in it.";
  return null;
}

const refineOptional = (check: (v: string) => string | null) =>
  (value: string | null, ctx: z.RefinementCtx) => {
    if (value === null) return;
    const problem = check(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  };

/** Optional phone typed by staff. Real-number validity (per clinic country) is checked by the API. */
export const optionalPhoneField = optionalShortText(40).superRefine(refineOptional(phoneShapeProblem));

/**
 * Optional email typed by staff: a whole address. Kept as typed; the API
 * lower-cases its own copy for matching.
 */
export const optionalEmailField = optionalShortText(320)
  .superRefine(refineOptional((v) => (isValidEmail(v) ? null : "Enter a full email address, like name@example.com.")));

/** A required name: a staff member's full name. */
export const personNameField = (max = 200) =>
  shortText(max).superRefine((value, ctx) => {
    const problem = nameProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

export const optionalNameField = (max = 120) => optionalShortText(max).superRefine(refineOptional(nameProblem));

/** Letters and spaces: a city, state or language. */
export const optionalPlaceField = (max = 120) =>
  optionalShortText(max).superRefine(refineOptional((v) => (/\d/.test(v) ? "This can't contain numbers." : !/\p{L}/u.test(v) ? "Enter letters." : null)));

export const optionalPostalCodeField = optionalShortText(20).superRefine(
  refineOptional((v) => (/^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(v) ? null : "Enter a postal code of letters and digits, like 33132.")),
);
