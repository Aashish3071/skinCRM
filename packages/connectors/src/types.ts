import type { SendableChannel } from "@skincrm/contracts";

/**
 * Provider adapters.
 *
 * Every integration sits behind one of these so the CRM core never depends on a
 * particular vendor (PRD 1: "External integrations must be replaceable adapters,
 * not hard-coded dependencies"). The mock implementations are what make the app
 * fully reviewable before any real credentials exist.
 */

export interface SendResult {
  /** The provider's own id, stored so a later status webhook can be matched. */
  providerMessageId: string;
  /** What the provider said on acceptance. Not proof of delivery. */
  acceptedAt: Date;
  /** Free-form provider detail, kept for diagnostics. Never contains a body. */
  providerMeta?: Record<string, unknown>;
}

/**
 * A provider refusing a send. `retryable` decides whether the worker backs off
 * and tries again or gives up: a bad address will never succeed, a rate limit
 * will.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly options: {
      retryable: boolean;
      providerCode?: string;
      /** Set when the provider says this recipient must never be contacted again. */
      permanentSuppression?: boolean;
    },
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface EmailMessage {
  to: string;
  toName?: string | null;
  subject: string;
  /** Plain text is required; HTML is optional and must carry the same meaning. */
  text: string;
  html?: string;
  fromAddress: string;
  fromName: string;
  replyTo?: string;
  /**
   * Required on promotional email under CAN-SPAM, alongside sender identity and
   * a physical postal address in the body.
   */
  unsubscribeUrl?: string;
  /**
   * Deduplication hint passed to providers that support it. The database
   * unique index is the real guard; this is belt and braces.
   */
  idempotencyKey: string;
}

export interface EmailConnector {
  readonly mode: "mock" | "live";
  send(message: EmailMessage): Promise<SendResult>;
  /** Used by the integration health screen (PRD INT-01). */
  verify(): Promise<{ ok: boolean; detail: string }>;
}

export interface WhatsAppTextMessage {
  kind: "text";
  toWaId: string;
  body: string;
  idempotencyKey: string;
}

export interface WhatsAppTemplateMessage {
  kind: "template";
  toWaId: string;
  templateName: string;
  languageCode: string;
  /** Positional variables, already rendered and screened. */
  variables: string[];
  idempotencyKey: string;
}

export type WhatsAppMessage = WhatsAppTextMessage | WhatsAppTemplateMessage;

export interface WhatsAppConnector {
  readonly mode: "mock" | "live";
  send(message: WhatsAppMessage): Promise<SendResult>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}

export interface Connectors {
  email: EmailConnector;
  whatsapp: WhatsAppConnector;
}

/** What a mock records, so tests and the development UI can assert on it. */
export interface CapturedMessage {
  channel: SendableChannel;
  to: string;
  subject?: string;
  body: string;
  idempotencyKey: string;
  sentAt: Date;
  providerMessageId: string;
}
