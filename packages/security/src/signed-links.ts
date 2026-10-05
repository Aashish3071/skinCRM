import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@skincrm/config";

/**
 * Stateless, signed links that grant one narrow thing to whoever holds them —
 * like the unsubscribe links (unsubscribe.ts). Used for "manage your
 * appointment" links in confirmation and reminder messages (PRD CAL-06).
 *
 * The purpose is part of what is signed, so a link made for one thing can
 * never be replayed as another. Fields may not contain ".".
 */
function sign(canonical: string): string {
  // A distinct key per use, derived from the master key, so these links and
  // unsubscribe links can't be confused even with identical field values.
  const key = createHmac("sha256", getEnv().CRYPTO_MASTER_KEY).update("signed-links/v1").digest();
  return createHmac("sha256", key).update(canonical).digest("base64url");
}

export function createSignedLink(purpose: string, fields: readonly string[]): string {
  if ([purpose, ...fields].some((f) => f.includes("."))) throw new Error("Signed link fields cannot contain '.'");
  const canonical = [purpose, ...fields].join(".");
  return `${Buffer.from(canonical).toString("base64url")}.${sign(canonical)}`;
}

/** The fields, or null when the link was edited, forged, or made for another purpose. */
export function verifySignedLink(purpose: string, token: string, fieldCount: number): string[] | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  let canonical: string;
  try {
    canonical = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = Buffer.from(sign(canonical));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const fields = canonical.split(".");
  if (fields[0] !== purpose || fields.length !== fieldCount + 1) return null;
  return fields.slice(1);
}
