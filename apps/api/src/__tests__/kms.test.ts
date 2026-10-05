/** AWS KMS root key and key rotation (D-93), with KMS faked. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeAllConnections, getOwnerDb, rotateEncryptionKeys, schema } from "@skincrm/db";
import { resetEnvCache } from "@skincrm/config";
import {
  createSignedLink,
  createUnsubscribeToken,
  decryptForClinic,
  encryptForClinic,
  initCrypto,
  isEncryptedUnderOldKey,
  resetCrypto,
  setKmsDecrypt,
  verifySignedLink,
  verifyUnsubscribeToken,
} from "@skincrm/security";
import { SEED, clinicIdBySlug } from "./helpers";

const saved = { ...process.env };
/** A fake KMS: "wrapped" blobs are looked up in this map. */
const vault = new Map<string, Buffer>();
const wrap = (key: Buffer) => {
  const blob = randomBytes(24).toString("base64");
  vault.set(blob, key);
  return blob;
};
setKmsDecrypt(async (blob) => {
  const key = vault.get(blob.toString("base64"));
  if (!key) throw new Error("AccessDeniedException");
  return key;
});

async function useKeys(env: Record<string, string | undefined>) {
  process.env = { ...saved, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  resetEnvCache();
  resetCrypto();
  await initCrypto();
}

afterEach(async () => {
  process.env = { ...saved };
  resetEnvCache();
  resetCrypto();
});
afterAll(async () => {
  setKmsDecrypt(undefined);
  await closeAllConnections();
});

describe("AWS KMS root key", () => {
  it("unwraps the key once at start-up and encrypts with it; no plaintext key in configuration", async () => {
    await useKeys({ CRYPTO_PROVIDER: "aws-kms", CRYPTO_WRAPPED_KEY: wrap(randomBytes(32)), CRYPTO_MASTER_KEY: undefined });
    const sealed = encryptForClinic("c1", "page token");
    expect(decryptForClinic("c1", sealed)).toBe("page token");
    expect(() => decryptForClinic("c2", sealed)).toThrow();
  });

  it("refuses to start when KMS won't unwrap the key", async () => {
    await expect(useKeys({ CRYPTO_PROVIDER: "aws-kms", CRYPTO_WRAPPED_KEY: Buffer.from("not-a-real-blob").toString("base64") })).rejects.toThrow(/AccessDenied/);
  });
});

describe("rotation from the local key to KMS", () => {
  it("reads old values, re-encrypts them, and keeps old links working", async () => {
    const local = "local-root-key-for-the-rotation-test-0001";
    await useKeys({ CRYPTO_PROVIDER: "local", CRYPTO_MASTER_KEY: local });
    const clinicId = await clinicIdBySlug(SEED.clinicA);
    const old = encryptForClinic(clinicId, "old secret");
    const link = createSignedLink("appt", [clinicId, "a1"]);
    const unsubscribe = createUnsubscribeToken({ clinicId, personId: "p1", channel: "email" });

    const { db } = getOwnerDb();
    const [row] = await db.insert(schema.integrationConnections).values({
      clinicId, provider: "email", externalAccountId: `kms-test-${Date.now()}`, encryptedSecret: old,
      config: { pinSealed: encryptForClinic(clinicId, "123456") },
    }).returning();

    try {
      await useKeys({ CRYPTO_PROVIDER: "aws-kms", CRYPTO_WRAPPED_KEY: wrap(randomBytes(32)), CRYPTO_PREVIOUS_MASTER_KEYS: local, CRYPTO_MASTER_KEY: undefined });
      expect(decryptForClinic(clinicId, old)).toBe("old secret");
      expect(isEncryptedUnderOldKey(clinicId, old)).toBe(true);
      expect(verifySignedLink("appt", link, 2)).toEqual([clinicId, "a1"]);
      expect(verifyUnsubscribeToken(unsubscribe)?.personId).toBe("p1");

      const report = await rotateEncryptionKeys(db);
      expect(report.unreadable.filter((u) => u.id === row!.id)).toEqual([]);
      const [after] = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, row!.id));
      expect(isEncryptedUnderOldKey(clinicId, after!.encryptedSecret!)).toBe(false);
      expect(isEncryptedUnderOldKey(clinicId, after!.config.pinSealed!)).toBe(false);
      expect(decryptForClinic(clinicId, after!.config.pinSealed!)).toBe("123456");

      // Once rotated, the old key can go: the row still decrypts.
      await useKeys({ CRYPTO_PROVIDER: "aws-kms", CRYPTO_WRAPPED_KEY: process.env.CRYPTO_WRAPPED_KEY, CRYPTO_MASTER_KEY: undefined });
      expect(decryptForClinic(clinicId, after!.encryptedSecret!)).toBe("old secret");
    } finally {
      await db.delete(schema.integrationConnections).where(eq(schema.integrationConnections.id, row!.id));
    }
  });
});
