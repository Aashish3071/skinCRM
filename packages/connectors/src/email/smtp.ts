import nodemailer, { type Transporter } from "nodemailer";
import type { EmailConnector, EmailMessage, SendResult } from "../types";
import { ConnectorError } from "../types";

/**
 * SMTP email connector (PRD MSG-01).
 *
 * Works with any SMTP relay — Amazon SES, Postmark, SendGrid, Mailgun all
 * offer one — which keeps the product provider-agnostic while a clinic picks
 * one. In development it points at Mailpit (docker compose, UI on
 * http://localhost:8025), so every email the CRM sends can be read without
 * anything leaving the machine.
 */
export class SmtpEmailConnector implements EmailConnector {
  readonly mode = "live" as const;
  private readonly transport: Transporter;

  constructor(options: { host: string; port: number; user?: string; password?: string }) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      // Implicit TLS on 465; everything else upgrades with STARTTLS when offered.
      secure: options.port === 465,
      auth: options.user ? { user: options.user, pass: options.password ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: { name: message.fromName, address: message.fromAddress },
        to: message.toName ? { name: message.toName, address: message.to } : message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: {
          // Lets a relay that supports it de-duplicate a retried send.
          "X-Idempotency-Key": message.idempotencyKey,
          ...(message.unsubscribeUrl
            ? {
                "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {}),
        },
      });
      return { providerMessageId: info.messageId, acceptedAt: new Date(), providerMeta: { response: info.response } };
    } catch (error) {
      throw toConnectorError(error);
    }
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.transport.verify();
      return { ok: true, detail: "Connected to the SMTP server" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Could not connect" };
    }
  }
}

/**
 * SMTP reply codes: 5xx is permanent (a bad mailbox must be suppressed), 4xx
 * and connection errors are temporary and worth retrying.
 */
function toConnectorError(error: unknown): ConnectorError {
  const code = (error as { responseCode?: number }).responseCode;
  const message = error instanceof Error ? error.message : "SMTP send failed";
  if (code && code >= 500 && code < 600) {
    const mailbox = code === 550 || code === 551 || code === 553;
    return new ConnectorError(message, {
      retryable: false,
      definitelyNotSent: true,
      providerCode: String(code),
      permanentSuppression: mailbox,
    });
  }
  return new ConnectorError(message, { retryable: true, definitelyNotSent: Boolean(code && code >= 400 && code < 500), providerCode: code ? String(code) : "connection" });
}
