import { Secret, TOTP } from "otpauth";

/**
 * TOTP for admin MFA (PRD ID-01). Standard 6-digit, 30-second SHA-1 codes,
 * which is what Google Authenticator, Authy and 1Password all support.
 */
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Accept the previous and next window as well as the current one. Clock drift on
 * a phone is common; one step either side is the usual compromise between
 * usability and shrinking the replay window.
 */
const VALIDATION_WINDOW = 1;

export interface TotpEnrollment {
  /** Base32 secret. Encrypt before storing. */
  secret: string;
  /** `otpauth://` URI for the QR code. */
  otpauthUrl: string;
}

export function createTotpEnrollment(params: {
  accountEmail: string;
  clinicName: string;
}): TotpEnrollment {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: `SkinCRM (${params.clinicName})`,
    label: params.accountEmail,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret,
  });
  return { secret: secret.base32, otpauthUrl: totp.toString() };
}

/**
 * Verify a submitted code. Returns the matched time counter so the caller can
 * store it and reject a second use of the same code inside its window — without
 * that, an intercepted code stays valid for up to 90 seconds.
 */
export function verifyTotp(params: {
  secretBase32: string;
  code: string;
  /** Counter value accepted most recently for this user, if any. */
  lastUsedCounter?: number | null;
}): { valid: boolean; counter: number | null } {
  const code = params.code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return { valid: false, counter: null };

  const totp = new TOTP({
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(params.secretBase32),
  });

  const delta = totp.validate({ token: code, window: VALIDATION_WINDOW });
  if (delta === null) return { valid: false, counter: null };

  const counter = Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + delta;
  if (params.lastUsedCounter != null && counter <= params.lastUsedCounter) {
    // Already spent. Treat a replay as a failure.
    return { valid: false, counter: null };
  }
  return { valid: true, counter };
}
