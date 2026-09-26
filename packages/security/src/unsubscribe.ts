import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@skincrm/config";

/**
 * Unsubscribe links (PRD MSG-04, and CAN-SPAM's requirement that promotional
 * email carry a working opt-out).
 *
 * The token is a stateless HMAC rather than a stored row, for two reasons:
 * an unsubscribe link has to keep working every time it is clicked, months
 * after the email was sent, and generating a database row per recipient per
 * campaign is a lot of storage for something that is pure derivation.
 *
 * It identifies the person and channel and is signed, so it cannot be edited
 * into someone else's opt-out. It grants nothing except the ability to stop
 * messages, which is deliberately a safe thing for a link to do.
 */

const VERSION = "u1";

interface UnsubscribePayload {
  clinicId: string;
  personId: string;
  channel: string;
}

function sign(canonical: string): string {
  return createHmac("sha256", getEnv().CRYPTO_MASTER_KEY).update(canonical).digest("base64url");
}

export function createUnsubscribeToken(payload: UnsubscribePayload): string {
  const canonical = [VERSION, payload.clinicId, payload.personId, payload.channel].join(".");
  return `${Buffer.from(canonical).toString("base64url")}.${sign(canonical)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts as [string, string];
  let canonical: string;
  try {
    canonical = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expected = sign(canonical);
  if (!constantTimeEqual(signature, expected)) return null;

  const fields = canonical.split(".");
  if (fields.length !== 4 || fields[0] !== VERSION) return null;

  return { clinicId: fields[1]!, personId: fields[2]!, channel: fields[3]! };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The link that goes in the email. */
export function unsubscribeUrl(payload: UnsubscribePayload): string {
  const env = getEnv();
  return `${env.PUBLIC_WEB_URL.replace(/\/$/, "")}/unsubscribe/${createUnsubscribeToken(payload)}`;
}
