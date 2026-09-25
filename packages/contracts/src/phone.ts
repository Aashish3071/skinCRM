import { parsePhoneNumberWithError, type CountryCode } from "libphonenumber-js";

export interface NormalizedPhone {
  /** E.164 form, e.g. `+13055550123`. Null when the input could not be parsed. */
  e164: string | null;
  /** Exactly what the user or provider gave us. Kept for audit (PRD 5). */
  raw: string;
  /** Digits-only national form, used as a loose matching fallback. */
  nationalDigits: string | null;
  country: string | null;
  valid: boolean;
}

/**
 * Normalize a phone to E.164 for matching (PRD ID-06) while always preserving
 * the original string. Defaults to US because the first clinic is in Florida;
 * a clinic's configured country overrides it.
 */
export function normalizePhone(input: string | null | undefined, defaultCountry = "US"): NormalizedPhone {
  const raw = (input ?? "").trim();
  if (raw === "") {
    return { e164: null, raw, nationalDigits: null, country: null, valid: false };
  }
  try {
    const parsed = parsePhoneNumberWithError(raw, defaultCountry as CountryCode);
    if (!parsed.isValid()) {
      return { e164: null, raw, nationalDigits: digitsOnly(raw), country: null, valid: false };
    }
    return {
      e164: parsed.number,
      raw,
      nationalDigits: parsed.nationalNumber,
      country: parsed.country ?? null,
      valid: true,
    };
  } catch {
    return { e164: null, raw, nationalDigits: digitsOnly(raw), country: null, valid: false };
  }
}

function digitsOnly(value: string): string | null {
  const digits = value.replace(/\D+/g, "");
  return digits === "" ? null : digits;
}

/**
 * WhatsApp gives a `wa_id` as digits with no plus sign. Turn it into E.164 so it
 * can match a person captured through any other channel (PRD WA-04).
 */
export function normalizeWhatsAppId(waId: string, defaultCountry = "US"): NormalizedPhone {
  const trimmed = waId.trim();
  const candidate = trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/\D+/g, "")}`;
  return normalizePhone(candidate, defaultCountry);
}

/** Lowercased and trimmed. Used as the email matching key; the original is stored too. */
export function normalizeEmail(input: string | null | undefined): string | null {
  const value = (input ?? "").trim().toLowerCase();
  return value === "" ? null : value;
}

/** Mask for previews, logs and the conversion-feedback preview screen (PRD FB-04). */
export function maskPhone(e164: string | null): string {
  if (!e164) return "—";
  return e164.length <= 4 ? "••••" : `${e164.slice(0, 3)}${"•".repeat(Math.max(0, e164.length - 6))}${e164.slice(-3)}`;
}

export function maskEmail(email: string | null): string {
  if (!email) return "—";
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(1, local.length - 1))}@${domain}`;
}
