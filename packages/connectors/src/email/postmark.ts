import type { FetchLike } from "../graph";
import type { EmailConnector, EmailMessage, SendResult } from "../types";
import { ConnectorError } from "../types";

/**
 * Postmark email (D-96): sends through Postmark's API rather than SMTP so we
 * get its message id, separate streams for service and marketing mail, and
 * the webhooks that tell us about deliveries, bounces, spam complaints,
 * unsubscribes and patients' replies (inbound).
 *
 * Message streams: "outbound" (transactional: confirmations, reminders,
 * replies to a patient) and "broadcast" (marketing) by default. Postmark adds
 * its own unsubscribe handling to broadcast streams.
 */
export class PostmarkEmailConnector implements EmailConnector {
  readonly mode = "live" as const;
  constructor(
    private readonly options: { serverToken: string; transactionalStream: string; broadcastStream: string },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const headers = message.unsubscribeUrl
      ? [
          { Name: "List-Unsubscribe", Value: `<${message.unsubscribeUrl}>` },
          { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
        ]
      : [];
    const from = `${message.fromName.replace(/["<>]/g, "")} <${message.fromAddress}>`;
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-postmark-server-token": this.options.serverToken,
        },
        body: JSON.stringify({
          From: from,
          To: message.toName ? `${message.toName.replace(/["<>]/g, "")} <${message.to}>` : message.to,
          Subject: message.subject,
          TextBody: message.text,
          ...(message.html ? { HtmlBody: message.html } : {}),
          ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
          Headers: headers,
          MessageStream: message.classification === "promotional" ? this.options.broadcastStream : this.options.transactionalStream,
          Metadata: { ...(message.metadata ?? {}), idempotencyKey: message.idempotencyKey.slice(0, 80) },
          // No open or link tracking: it tells nobody anything useful here and
          // embeds third-party pixels in patients' mail.
          TrackOpens: false,
          TrackLinks: "None",
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ConnectorError(`Could not reach Postmark: ${error instanceof Error ? error.message : "network error"}`, { retryable: true, providerCode: "network" });
    }
    const data = (await response.json().catch(() => ({}))) as { MessageID?: string; ErrorCode?: number; Message?: string; SubmittedAt?: string };
    if (response.ok && data.ErrorCode === 0 && data.MessageID) {
      return { providerMessageId: data.MessageID, acceptedAt: data.SubmittedAt ? new Date(data.SubmittedAt) : new Date(), providerMeta: { stream: message.classification === "promotional" ? "broadcast" : "transactional" } };
    }
    const code = data.ErrorCode;
    throw new ConnectorError(data.Message ?? `Postmark returned ${response.status}`, {
      // 406: the address is inactive (hard bounce, complaint or unsubscribe) — never retry, suppress.
      retryable: response.status >= 500 || response.status === 429,
      definitelyNotSent: response.status === 422 || response.status === 401,
      providerCode: code !== undefined ? `postmark_${code}` : String(response.status),
      permanentSuppression: code === 406,
    });
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.fetchImpl("https://api.postmarkapp.com/server", {
        headers: { accept: "application/json", "x-postmark-server-token": this.options.serverToken },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await r.json().catch(() => ({}))) as { Name?: string; Message?: string; InboundAddress?: string };
      return r.ok ? { ok: true, detail: `Connected to Postmark server "${data.Name ?? "?"}"` } : { ok: false, detail: data.Message ?? `Postmark returned ${r.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Could not reach Postmark" };
    }
  }
}
