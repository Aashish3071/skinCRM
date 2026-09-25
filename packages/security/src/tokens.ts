import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque secrets (session cookies, invite links, password resets, booking
 * links). The plaintext is shown to the holder once; only its SHA-256 digest is
 * stored, so a database read cannot be replayed as a credential.
 *
 * SHA-256 is correct here and Argon2 is not: these are 256 bits of entropy from
 * a CSPRNG, not user-chosen passwords, so there is nothing to brute-force and
 * lookup must stay fast enough to run on every request.
 */

export interface GeneratedToken {
  /** Give this to the user. Never persist it. */
  token: string;
  /** Persist this. */
  tokenHash: string;
}

export function generateToken(byteLength = 32): GeneratedToken {
  const token = randomBytes(byteLength).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking the position of the first difference.
 *
 * Validates that both inputs are genuinely hex first. `Buffer.from("zz", "hex")`
 * silently returns an EMPTY buffer rather than throwing, so without this check
 * two different invalid strings would compare as equal.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0 || a.length % 2 !== 0) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  // A short decode means the input contained non-hex characters.
  if (left.length !== a.length / 2 || right.length !== b.length / 2) return false;
  return timingSafeEqual(left, right);
}

/**
 * MFA recovery codes. Grouped in fives so they can be read aloud or written
 * down, using an alphabet without 0/O/1/I/L to avoid transcription errors.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => {
    const raw = Array.from(randomBytes(10), (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
  return { codes, hashes: codes.map((c) => hashToken(normalizeRecoveryCode(c))) };
}

/** Accept a code however the user typed it: lowercase, spaced, or missing the dash. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Idempotency key for outbound sends (PRD MSG-05). Built from the identity of
 * the thing being sent rather than a timestamp, so a replayed job or a retried
 * webhook produces the same key and the unique index rejects the duplicate.
 */
export function buildIdempotencyKey(parts: {
  clinicId: string;
  personId: string;
  ruleId?: string | null;
  triggerEventId?: string | null;
  scheduleInstance?: string | null;
  channel: string;
}): string {
  const canonical = [
    parts.clinicId,
    parts.personId,
    parts.ruleId ?? "-",
    parts.triggerEventId ?? "-",
    parts.scheduleInstance ?? "-",
    parts.channel,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
