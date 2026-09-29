import { ConnectorError } from "../types";
import { GRAPH_BASE, graphRequest, type FetchLike } from "../graph";

/**
 * WhatsApp Embedded Signup (D-88).
 *
 * The clinic clicks "Connect WhatsApp"; Meta's own popup (Facebook JS SDK,
 * `FB.login` with an Embedded Signup configuration) walks them through picking
 * or creating the business portfolio, WhatsApp Business Account and number.
 * The popup hands the page a one-time `code` plus the WABA id and phone-number
 * id; the API trades the code for a business token, subscribes our app to the
 * WABA's webhooks and, for a brand-new number, registers it for the Cloud API.
 *
 * Coexistence: a clinic already using the WhatsApp Business *app* on its number
 * can keep using the app on the phone while the CRM uses the same number
 * (featureType `whatsapp_business_app_onboarding`). Those numbers are already
 * registered, so registration is skipped.
 *
 * Needs, once per deployment: the Meta app from "Connect with Facebook", with
 * the WhatsApp product, an Embedded Signup configuration (META_WA_CONFIG_ID),
 * `whatsapp_business_management` + `whatsapp_business_messaging` approved, and
 * the app's WhatsApp webhook pointed at /webhooks/whatsapp.
 */
export interface WhatsAppNumberDetails {
  displayPhone: string | null;
  verifiedName: string | null;
}

export interface WhatsAppSignupClient {
  readonly mode: "mock" | "live";
  /** One-time code from the popup → business integration token. */
  exchangeCode(code: string): Promise<string>;
  /** Our app receives this WABA's message and status webhooks. */
  subscribeApp(wabaId: string, token: string): Promise<void>;
  /** A new number must be registered for the Cloud API, with a 6-digit PIN. */
  registerNumber(phoneNumberId: string, token: string, pin: string): Promise<void>;
  numberDetails(phoneNumberId: string, token: string): Promise<WhatsAppNumberDetails>;
}

export class LiveWhatsAppSignupClient implements WhatsAppSignupClient {
  readonly mode = "live" as const;
  constructor(private readonly app: { appId: string; appSecret: string }, private readonly fetchImpl: FetchLike = fetch) {}

  async exchangeCode(code: string): Promise<string> {
    const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
    url.searchParams.set("client_id", this.app.appId);
    url.searchParams.set("client_secret", this.app.appSecret);
    url.searchParams.set("code", code);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new ConnectorError(`Could not reach Meta: ${error instanceof Error ? error.message : "network error"}`, { retryable: true, providerCode: "network" });
    }
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
    if (!response.ok || !data.access_token) {
      throw new ConnectorError(data.error?.message ?? `Meta returned ${response.status}`, { retryable: false, providerCode: "oauth" });
    }
    return data.access_token;
  }

  async subscribeApp(wabaId: string, token: string): Promise<void> {
    if (!/^\d+$/.test(wabaId)) throw new ConnectorError("Invalid WhatsApp Business Account id", { retryable: false });
    await graphRequest(this.fetchImpl, `${wabaId}/subscribed_apps`, token, { method: "POST" });
  }

  async registerNumber(phoneNumberId: string, token: string, pin: string): Promise<void> {
    if (!/^\d+$/.test(phoneNumberId)) throw new ConnectorError("Invalid phone number id", { retryable: false });
    await graphRequest(this.fetchImpl, `${phoneNumberId}/register`, token, { method: "POST", body: { messaging_product: "whatsapp", pin } });
  }

  async numberDetails(phoneNumberId: string, token: string): Promise<WhatsAppNumberDetails> {
    const data = await graphRequest<{ display_phone_number?: string; verified_name?: string }>(
      this.fetchImpl, `${phoneNumberId}?fields=display_phone_number,verified_name`, token,
    );
    return { displayPhone: data.display_phone_number ?? null, verifiedName: data.verified_name ?? null };
  }
}

/** Demo mode: no popup; a made-up number that the built-in test phone answers. */
export class MockWhatsAppSignupClient implements WhatsAppSignupClient {
  readonly mode = "mock" as const;
  readonly registered = new Set<string>();
  async exchangeCode(code: string): Promise<string> {
    if (code !== "mock-wa-code") throw new ConnectorError("Unknown code", { retryable: false, providerCode: "oauth" });
    return "mock-wa-business-token";
  }
  async subscribeApp(): Promise<void> {}
  async registerNumber(phoneNumberId: string): Promise<void> {
    this.registered.add(phoneNumberId);
  }
  async numberDetails(): Promise<WhatsAppNumberDetails> {
    return { displayPhone: "+1 305-555-0100", verifiedName: "Demo Skin Clinic" };
  }
}
