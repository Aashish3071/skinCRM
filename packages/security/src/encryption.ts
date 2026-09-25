import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  hkdfSync,
} from "node:crypto";
import { getEnv } from "@skincrm/config";

/**
 * Envelope encryption for per-clinic provider credentials (WhatsApp tokens, Meta
 * access tokens, SMTP passwords, TOTP secrets) and for raw third-party payloads.
 *
 * Design:
 *  - AES-256-GCM, so ciphertext is authenticated; tampering fails to decrypt.
 *  - A per-clinic data key derived from the master key via HKDF. One clinic's
 *    ciphertext cannot be decrypted with another clinic's derived key, which
 *    limits the blast radius of a logic bug that mixes up clinic ids.
 *  - The clinic id is bound as additional authenticated data, so a ciphertext
 *    copied from clinic A's row into clinic B's row fails to decrypt instead of
 *    silently yielding A's secret.
 *  - A version prefix so the format can change without a flag day.
 *
 * Production uses a KMS (CRYPTO_PROVIDER=aws-kms) and the local provider is
 * refused at boot; see assertProductionSafety in @skincrm/config.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;

export interface EncryptedValue {
  /** `v1:<keyId>:<iv>:<tag>:<ciphertext>`, all base64url. Safe to store as text. */
  ciphertext: string;
}

function masterKey(): Buffer {
  const env = getEnv();
  // The env value is a passphrase, not raw key material; hash it to a fixed width.
  return createHash("sha256").update(env.CRYPTO_MASTER_KEY, "utf8").digest();
}

/** Derive a stable per-clinic key. Same clinic id always yields the same key. */
function deriveClinicKey(clinicId: string): Buffer {
  const derived = hkdfSync("sha256", masterKey(), Buffer.from(clinicId, "utf8"), Buffer.from("skincrm-clinic-credentials", "utf8"), KEY_BYTES);
  return Buffer.from(derived);
}

/** Short, non-secret fingerprint of the key used, so rotation can be detected. */
function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function encryptForClinic(clinicId: string, plaintext: string): string {
  const key = deriveClinicKey(clinicId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(clinicId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyId(key), iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    ":",
  );
}

export function decryptForClinic(clinicId: string, stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 5) throw new EncryptionError("Malformed ciphertext");
  const [version, , ivPart, tagPart, dataPart] = parts as [string, string, string, string, string];
  if (version !== VERSION) throw new EncryptionError(`Unsupported ciphertext version ${version}`);

  const key = deriveClinicKey(clinicId);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64url"));
    decipher.setAAD(Buffer.from(clinicId, "utf8"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong clinic, tampered ciphertext, or a rotated master key all land here.
    throw new EncryptionError("Unable to decrypt value for this clinic");
  }
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

/**
 * One-way fingerprint for deduplicating stored raw payloads without keeping a
 * second readable copy (PRD 5: "raw payload reference/hash").
 */
export function payloadFingerprint(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

/** Deterministic JSON so key order cannot change a fingerprint. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}
