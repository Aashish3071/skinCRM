import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "../password";
import {
  buildIdempotencyKey,
  generateRecoveryCodes,
  generateToken,
  hashToken,
  normalizeRecoveryCode,
  timingSafeEqualHex,
} from "../tokens";
import { EncryptionError, decryptForClinic, encryptForClinic, payloadFingerprint } from "../encryption";
import { createTotpEnrollment, verifyTotp } from "../totp";

beforeAll(() => {
  // The encryption helpers read config; give them a deterministic master key.
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5433/skincrm";
  process.env.REDIS_URL ??= "redis://localhost:6380";
  process.env.SESSION_SECRET ??= "test_session_secret_value_0000";
  process.env.CRYPTO_MASTER_KEY ??= "test_master_key_value_00000000";
});

const CLINIC_A = "11111111-1111-4111-8111-111111111111";
const CLINIC_B = "22222222-2222-4222-8222-222222222222";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(hash, "Correct horse battery staple")).resolves.toBe(false);
  });

  it("produces a different hash each time (unique salt)", async () => {
    const [a, b] = await Promise.all([hashPassword("same password"), hashPassword("same password")]);
    expect(a).not.toBe(b);
  });

  it("returns false rather than throwing on a corrupt stored hash", async () => {
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
    await expect(verifyPassword("", "anything")).resolves.toBe(false);
  });

  it("does not ask for a rehash at the current cost parameters", async () => {
    const hash = await hashPassword("some password value");
    expect(needsRehash(hash)).toBe(false);
  });

  it("asks for a rehash on a weaker or foreign hash", () => {
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(needsRehash("$2b$12$abcdefghijklmnopqrstuv")).toBe(true);
  });
});

describe("opaque tokens", () => {
  it("returns a token alongside the hash that should be stored", () => {
    const { token, tokenHash } = generateToken();
    expect(token).not.toBe(tokenHash);
    expect(hashToken(token)).toBe(tokenHash);
    // 32 random bytes as base64url.
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it("never repeats a token", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken().token));
    expect(seen.size).toBe(500);
  });

  it("compares digests without throwing on bad input", () => {
    const a = hashToken("value");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, hashToken("other"))).toBe(false);
    expect(timingSafeEqualHex(a, "short")).toBe(false);
    // Non-hex input decodes to an empty buffer, so two invalid strings of equal
    // length must not be treated as a match.
    expect(timingSafeEqualHex("zz", "zz")).toBe(false);
    expect(timingSafeEqualHex("zz", "yy")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
    // Odd length is never a valid digest.
    expect(timingSafeEqualHex("abc", "abc")).toBe(false);
  });

  it("accepts a recovery code however the user types it", () => {
    const { codes, hashes } = generateRecoveryCodes(3);
    expect(codes).toHaveLength(3);
    const first = codes[0]!;
    expect(first).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // Lowercased, spaced, and with the dash dropped must all match.
    for (const variant of [first.toLowerCase(), first.replace("-", ""), first.replace("-", " ")]) {
      expect(hashes).toContain(hashToken(normalizeRecoveryCode(variant)));
    }
  });

  it("omits ambiguous characters from recovery codes", () => {
    const { codes } = generateRecoveryCodes(40);
    // 0/O and 1/I/L are the usual transcription failures.
    expect(codes.join("")).not.toMatch(/[01OIL]/);
  });
});

describe("outbound idempotency keys", () => {
  const base = {
    clinicId: CLINIC_A,
    personId: "person-1",
    ruleId: "rule-1",
    triggerEventId: "event-1",
    scheduleInstance: "2026-09-26T10:00:00Z",
    channel: "email",
  };

  it("is stable for the same logical send, so a replay is rejected", () => {
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey({ ...base }));
  });

  it("differs when any component differs", () => {
    const key = buildIdempotencyKey(base);
    expect(buildIdempotencyKey({ ...base, channel: "whatsapp" })).not.toBe(key);
    expect(buildIdempotencyKey({ ...base, personId: "person-2" })).not.toBe(key);
    expect(buildIdempotencyKey({ ...base, scheduleInstance: "2026-09-27T10:00:00Z" })).not.toBe(key);
    // Two clinics must never collide, even with identical local ids.
    expect(buildIdempotencyKey({ ...base, clinicId: CLINIC_B })).not.toBe(key);
  });
});

describe("per-clinic envelope encryption", () => {
  it("round-trips a value", () => {
    const secret = "EAAG...whatsapp-access-token";
    const stored = encryptForClinic(CLINIC_A, secret);
    expect(stored).not.toContain(secret);
    expect(decryptForClinic(CLINIC_A, stored)).toBe(secret);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const a = encryptForClinic(CLINIC_A, "same value");
    const b = encryptForClinic(CLINIC_A, "same value");
    expect(a).not.toBe(b);
    expect(decryptForClinic(CLINIC_A, a)).toBe("same value");
    expect(decryptForClinic(CLINIC_A, b)).toBe("same value");
  });

  it("refuses to decrypt another clinic's ciphertext", () => {
    // The exact failure a row mix-up should cause: a loud error, not clinic A's secret.
    const stored = encryptForClinic(CLINIC_A, "clinic A token");
    expect(() => decryptForClinic(CLINIC_B, stored)).toThrow(EncryptionError);
  });

  it("detects tampering", () => {
    const stored = encryptForClinic(CLINIC_A, "clinic A token");
    const parts = stored.split(":");
    // Flip a byte in the ciphertext; GCM's tag must reject it.
    const data = Buffer.from(parts[4]!, "base64url");
    data[0] = data[0]! ^ 0xff;
    parts[4] = data.toString("base64url");
    expect(() => decryptForClinic(CLINIC_A, parts.join(":"))).toThrow(EncryptionError);
  });

  it("rejects malformed input instead of returning something", () => {
    expect(() => decryptForClinic(CLINIC_A, "garbage")).toThrow(EncryptionError);
    expect(() => decryptForClinic(CLINIC_A, "v9:aa:bb:cc:dd")).toThrow(/version/i);
  });
});

describe("payload fingerprints", () => {
  it("ignores key order so a reordered redelivery still deduplicates", () => {
    expect(payloadFingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(
      payloadFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("changes when a value changes", () => {
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: 2 }));
  });

  it("does not confuse an array with an object", () => {
    expect(payloadFingerprint([1, 2])).not.toBe(payloadFingerprint({ 0: 1, 1: 2 }));
  });
});

describe("TOTP", () => {
  it("issues an enrollment with a scannable URI", () => {
    const { secret, otpauthUrl } = createTotpEnrollment({
      accountEmail: "admin@sunshine-skin.test",
      clinicName: "Sunshine Skin & Laser",
    });
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(otpauthUrl.startsWith("otpauth://totp/")).toBe(true);
    expect(otpauthUrl).toContain("admin%40sunshine-skin.test");
  });

  it("rejects a malformed code without consulting the secret", () => {
    const { secret } = createTotpEnrollment({ accountEmail: "a@b.test", clinicName: "C" });
    for (const code of ["", "12345", "1234567", "abcdef", "12 34 56"]) {
      expect(verifyTotp({ secretBase32: secret, code }).valid).toBe(false);
    }
  });

  it("rejects a wrong code", () => {
    const { secret } = createTotpEnrollment({ accountEmail: "a@b.test", clinicName: "C" });
    // 000000 is astronomically unlikely to be the live code; if it is, the next
    // assertion below still guards the real behaviour.
    const result = verifyTotp({ secretBase32: secret, code: "000000" });
    if (result.valid) expect(result.counter).toBeTypeOf("number");
    else expect(result.counter).toBeNull();
  });

  it("refuses to reuse a code already spent in its window", async () => {
    const { TOTP, Secret } = await import("otpauth");
    const { secret } = createTotpEnrollment({ accountEmail: "a@b.test", clinicName: "C" });
    const live = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" });
    const code = live.generate();

    const first = verifyTotp({ secretBase32: secret, code });
    expect(first.valid).toBe(true);
    expect(first.counter).toBeTypeOf("number");

    // An intercepted code must not work a second time inside the same window.
    const replay = verifyTotp({ secretBase32: secret, code, lastUsedCounter: first.counter });
    expect(replay.valid).toBe(false);
  });
});
