import { randomUUID } from "node:crypto";
import type {
  CapturedMessage,
  SendResult,
  WhatsAppConnector,
  WhatsAppMessage,
} from "../types";
import { ConnectorError } from "../types";

/**
 * In-memory WhatsApp connector.
 *
 * Mirrors the Cloud API's shape closely enough that the send-safety checks
 * around it are exercised for real: template-only outside the service window,
 * an approved template name, and a wa_id rather than a display number.
 *
 * It does NOT enforce the service window itself — that is the CRM's job and
 * must be tested in the CRM, not delegated to a mock that production would not
 * repeat.
 */
export class MockWhatsAppConnector implements WhatsAppConnector {
  readonly mode = "mock" as const;
  private readonly captured: CapturedMessage[] = [];

  constructor(
    private readonly options: {
      /** wa_ids that fail permanently, e.g. not a WhatsApp user. */
      invalidRecipients?: string[];
      /** Template names the provider has paused or rejected. */
      unavailableTemplates?: string[];
    } = {},
  ) {}

  async send(message: WhatsAppMessage): Promise<SendResult> {
    if (this.options.invalidRecipients?.includes(message.toWaId)) {
      throw new ConnectorError("Recipient is not a WhatsApp user", {
        retryable: false,
        providerCode: "invalid_recipient",
        permanentSuppression: true,
      });
    }

    if (
      message.kind === "template" &&
      this.options.unavailableTemplates?.includes(message.templateName)
    ) {
      throw new ConnectorError(`Template "${message.templateName}" is not available`, {
        retryable: false,
        providerCode: "template_unavailable",
      });
    }

    const providerMessageId = `mock-wa-${randomUUID()}`;
    this.captured.push({
      channel: "whatsapp",
      to: message.toWaId,
      body:
        message.kind === "text"
          ? message.body
          : `[template:${message.templateName}] ${message.variables.join(" | ")}`,
      idempotencyKey: message.idempotencyKey,
      sentAt: new Date(),
      providerMessageId,
    });

    return { providerMessageId, acceptedAt: new Date(), providerMeta: { mock: true } };
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "Mock WhatsApp connector — nothing leaves this process." };
  }

  outbox(): readonly CapturedMessage[] {
    return this.captured;
  }

  reset(): void {
    this.captured.length = 0;
  }
}
