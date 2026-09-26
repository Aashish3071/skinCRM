import { randomUUID } from "node:crypto";
import { getEnv } from "@skincrm/config";
import { getConnectors } from "@skincrm/connectors";
import { logger } from "../logger";

/**
 * Account email to staff: invitations and password resets.
 *
 * Deliberately outside the client send gate. These go to clinic staff about
 * their own account, not to clients, so consent, quiet hours and the client
 * kill switch do not apply — and a password reset that waits for 08:00 is a
 * locked-out front desk. They still go through the same connector, so in
 * development they land in Mailpit (http://localhost:8025) and in production
 * in the clinic's relay.
 *
 * Never throws: a failed invite email must not roll back the invite itself.
 * Staff can re-send, and the failure is logged.
 */
export async function sendSystemEmail(params: { to: string; subject: string; text: string }): Promise<boolean> {
  const env = getEnv();
  try {
    await getConnectors().email.send({
      to: params.to,
      subject: params.subject,
      text: params.text,
      fromAddress: env.EMAIL_FROM_ADDRESS,
      fromName: env.EMAIL_FROM_NAME,
      idempotencyKey: `system:${randomUUID()}`,
    });
    return true;
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "System email failed");
    return false;
  }
}

export function webLink(path: string): string {
  return new URL(path, getEnv().PUBLIC_WEB_URL).toString();
}
