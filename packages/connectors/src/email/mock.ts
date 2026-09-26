import { randomUUID } from "node:crypto";
import type { CapturedMessage, EmailConnector, EmailMessage, SendResult } from "../types";
import { ConnectorError } from "../types";

/**
 * In-memory email connector.
 *
 * The default in development and test, so the whole product is reviewable
 * before a provider is chosen or a sending domain is verified (PRD 10.5:
 * "Support mock connectors so the app is reviewable without credentials").
 *
 * It simulates the failures that matter rather than always succeeding: a
 * silently perfect mock hides every retry and suppression path until
 * production, which is exactly where you do not want to discover them.
 */
export class MockEmailConnector implements EmailConnector {
  readonly mode = "mock" as const;
  private readonly captured: CapturedMessage[] = [];

  constructor(
    private readonly options: {
      /** Addresses that hard-bounce, to exercise permanent suppression. */
      bounceAddresses?: string[];
      /** Addresses that fail transiently, to exercise retry. */
      transientFailureAddresses?: string[];
    } = {},
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const to = message.to.toLowerCase();

    if (this.options.bounceAddresses?.some((a) => a.toLowerCase() === to)) {
      throw new ConnectorError("Recipient address does not exist", {
        retryable: false,
        providerCode: "hard_bounce",
        permanentSuppression: true,
      });
    }

    if (this.options.transientFailureAddresses?.some((a) => a.toLowerCase() === to)) {
      throw new ConnectorError("Provider temporarily unavailable", {
        retryable: true,
        providerCode: "temporary_failure",
      });
    }

    const providerMessageId = `mock-email-${randomUUID()}`;
    this.captured.push({
      channel: "email",
      to: message.to,
      subject: message.subject,
      body: message.text,
      idempotencyKey: message.idempotencyKey,
      sentAt: new Date(),
      providerMessageId,
    });

    return { providerMessageId, acceptedAt: new Date(), providerMeta: { mock: true } };
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "Mock email connector — nothing leaves this process." };
  }

  /** Test and development affordance; not part of the connector interface. */
  outbox(): readonly CapturedMessage[] {
    return this.captured;
  }

  reset(): void {
    this.captured.length = 0;
  }
}
