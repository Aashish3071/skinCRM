import type { SendResult, WhatsAppConnector, WhatsAppMessage } from "../types";
import { graphRequest, type FetchLike } from "../graph";

/**
 * WhatsApp Business Cloud API (PRD WA-05, INT-02).
 *
 * One instance per clinic: each clinic sends from its own business number
 * (`phoneNumberId`) with its own token, loaded from its encrypted
 * integration connection.
 */
export class WhatsAppCloudConnector implements WhatsAppConnector {
  readonly mode = "live" as const;

  constructor(
    private readonly options: { phoneNumberId: string; accessToken: string },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(message: WhatsAppMessage): Promise<SendResult> {
    const body =
      message.kind === "text"
        ? {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: message.toWaId,
            type: "text",
            text: { body: message.body, preview_url: false },
          }
        : {
            messaging_product: "whatsapp",
            to: message.toWaId,
            type: "template",
            template: {
              name: message.templateName,
              language: { code: message.languageCode },
              ...(message.variables.length
                ? { components: [{ type: "body", parameters: message.variables.map((text) => ({ type: "text", text })) }] }
                : {}),
            },
          };

    const result = await graphRequest<{ messages?: { id: string }[] }>(
      this.fetchImpl,
      `${this.options.phoneNumberId}/messages`,
      this.options.accessToken,
      { method: "POST", body },
    );
    const id = result.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp accepted the request but returned no message id");
    return { providerMessageId: id, acceptedAt: new Date(), providerMeta: { phoneNumberId: this.options.phoneNumberId } };
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const n = await graphRequest<{ display_phone_number?: string; verified_name?: string }>(
        this.fetchImpl,
        `${this.options.phoneNumberId}?fields=display_phone_number,verified_name`,
        this.options.accessToken,
      );
      return { ok: true, detail: `Connected to ${n.verified_name ?? "your business"} (${n.display_phone_number ?? "number"})` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Could not verify" };
    }
  }
}
