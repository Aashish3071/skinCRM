import { createHmac, timingSafeEqual } from "node:crypto";
import { linkSigningSecrets } from "./encryption";

/**
 * Reply-To addresses for patient email (D-96): `inbox+<token>@inbound…`.
 * Postmark hands back the part after "+" as MailboxHash, which tells us whose
 * conversation a reply belongs to without trusting the From header.
 *
 * The token is the person's id (32 hex) plus a 12-character signature, so it
 * fits comfortably in an email local part (64 characters) and can't be guessed
 * or edited into someone else's thread.
 */
function signature(personHex: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(`reply:${personHex}`).digest("hex").slice(0, 12);
}

export function createReplyToken(personId: string): string {
  const hex = personId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("Not a person id");
  return `${hex}${signature(hex, linkSigningSecrets()[0]!)}`;
}

/** The person id, or null for anything forged, edited or unrelated. */
export function verifyReplyToken(token: string): string | null {
  const t = token.trim().toLowerCase();
  if (!/^[0-9a-f]{44}$/.test(t)) return null;
  const hex = t.slice(0, 32);
  const given = Buffer.from(t.slice(32));
  const valid = linkSigningSecrets().some((secret) => {
    const expected = Buffer.from(signature(hex, secret));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!valid) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `inbox@inbound.example.com` + token → `inbox+token@inbound.example.com`. */
export function replyAddress(inboundAddress: string, personId: string): string {
  const [local, domain] = inboundAddress.split("@") as [string, string];
  return `${local.split("+")[0]}+${createReplyToken(personId)}@${domain}`;
}
