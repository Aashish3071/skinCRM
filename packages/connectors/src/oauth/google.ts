import { ConnectorError } from "../types";
import type { FetchLike } from "../graph";

/**
 * "Connect with Google Ads".
 *
 * The clinic signs in with Google and allows access to Google Ads; we keep the
 * refresh token (encrypted), let them pick the ad account, and add our webhook
 * — URL plus a per-clinic key — as a delivery method on every lead form asset
 * in that account. New forms added later are picked up with "Check for new
 * lead forms".
 *
 * Needs, once per deployment: a Google Cloud OAuth client (web application)
 * with the redirect URI registered, the Google Ads API enabled, and a Google
 * Ads developer token with Basic or Standard access.
 *
 * VERIFY BEFORE GO-LIVE: the lead-form webhook update (asset mutate with
 * `lead_form_asset.delivery_methods`) follows the Google Ads API reference at
 * the time of writing. Connect a real test account and confirm with Google's
 * "Send test data" that a lead arrives before relying on it.
 */
export const GOOGLE_ADS_API_VERSION = "v21";
const ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
export const GOOGLE_OAUTH_SCOPES = ["https://www.googleapis.com/auth/adwords"] as const;

export interface GoogleAdsAccount {
  /** Digits only. */
  customerId: string;
  name: string;
  /** The manager account to call through, when access comes via one. */
  loginCustomerId: string | null;
}

export interface GoogleLeadForm {
  resourceName: string;
  id: string;
  name: string;
  /** Webhook URLs already set on the form. */
  webhookUrls: string[];
}

export interface GoogleOAuthClient {
  readonly mode: "mock" | "live";
  authorizeUrl(params: { state: string; redirectUri: string }): string;
  /** Code → refresh token. */
  exchangeCode(params: { code: string; redirectUri: string }): Promise<string>;
  listAccounts(refreshToken: string): Promise<GoogleAdsAccount[]>;
  listLeadForms(refreshToken: string, account: GoogleAdsAccount): Promise<GoogleLeadForm[]>;
  addWebhook(refreshToken: string, account: GoogleAdsAccount, form: GoogleLeadForm, webhook: { url: string; key: string }): Promise<void>;
}

interface GoogleApp {
  clientId: string;
  clientSecret: string;
  developerToken: string;
}

export class LiveGoogleOAuthClient implements GoogleOAuthClient {
  readonly mode = "live" as const;
  constructor(private readonly app: GoogleApp, private readonly fetchImpl: FetchLike = fetch) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.app.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
    // offline + consent: always return a refresh token, even on a reconnect.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  private async token(body: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...body }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ConnectorError(`Could not reach Google: ${error instanceof Error ? error.message : "network error"}`, { retryable: true, providerCode: "network" });
    }
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error_description?: string; error?: string };
    if (!response.ok) throw new ConnectorError(data.error_description ?? data.error ?? `Google returned ${response.status}`, { retryable: false, providerCode: "oauth" });
    return data;
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<string> {
    const data = await this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (!data.refresh_token) throw new ConnectorError("Google did not return a refresh token. Remove SkinCRM's access in your Google account settings and connect again.", { retryable: false, providerCode: "oauth" });
    return data.refresh_token;
  }

  private async accessToken(refreshToken: string): Promise<string> {
    const data = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (!data.access_token) throw new ConnectorError("Google did not return an access token", { retryable: false, providerCode: "oauth" });
    return data.access_token;
  }

  private async ads<T>(accessToken: string, path: string, init: { method?: "GET" | "POST"; body?: unknown; loginCustomerId?: string | null } = {}): Promise<T> {
    const response = await this.fetchImpl(`${ADS_BASE}/${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "developer-token": this.app.developerToken,
        ...(init.loginCustomerId ? { "login-customer-id": init.loginCustomerId } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
    if (!response.ok) {
      throw new ConnectorError(data.error?.message ?? `Google Ads returned ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
        providerCode: data.error?.status ?? String(response.status),
      });
    }
    return data;
  }

  private search<T>(accessToken: string, customerId: string, query: string, loginCustomerId: string | null) {
    return this.ads<{ results?: T[] }>(accessToken, `customers/${customerId}/googleAds:search`, { method: "POST", body: { query }, loginCustomerId });
  }

  async listAccounts(refreshToken: string): Promise<GoogleAdsAccount[]> {
    const access = await this.accessToken(refreshToken);
    const { resourceNames = [] } = await this.ads<{ resourceNames?: string[] }>(access, "customers:listAccessibleCustomers");
    const accounts = new Map<string, GoogleAdsAccount>();
    for (const resource of resourceNames.slice(0, 20)) {
      const rootId = resource.replace("customers/", "");
      // Covers both a plain ad account (itself, level 0) and a manager
      // account (its direct client accounts, level 1).
      const { results = [] } = await this.search<{ customerClient: { id: string; descriptiveName?: string; manager?: boolean; level?: string } }>(
        access, rootId,
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.level <= 1",
        rootId,
      ).catch(() => ({ results: [] }));
      for (const { customerClient: c } of results) {
        if (c.manager) continue;
        const id = String(c.id);
        if (!accounts.has(id)) accounts.set(id, { customerId: id, name: c.descriptiveName || `Account ${id}`, loginCustomerId: id === rootId ? null : rootId });
      }
    }
    return [...accounts.values()];
  }

  async listLeadForms(refreshToken: string, account: GoogleAdsAccount): Promise<GoogleLeadForm[]> {
    const access = await this.accessToken(refreshToken);
    const { results = [] } = await this.search<{ asset: { resourceName: string; id: string; name?: string; leadFormAsset?: { headline?: string; businessName?: string; deliveryMethods?: { webhook?: { advertiserWebhookUrl?: string } }[] } } }>(
      access, account.customerId,
      "SELECT asset.resource_name, asset.id, asset.name, asset.lead_form_asset.headline, asset.lead_form_asset.business_name, asset.lead_form_asset.delivery_methods FROM asset WHERE asset.type = 'LEAD_FORM'",
      account.loginCustomerId,
    );
    return results.map(({ asset }) => ({
      resourceName: asset.resourceName,
      id: String(asset.id),
      name: asset.name || asset.leadFormAsset?.headline || asset.leadFormAsset?.businessName || `Lead form ${asset.id}`,
      webhookUrls: (asset.leadFormAsset?.deliveryMethods ?? []).map((d) => d.webhook?.advertiserWebhookUrl).filter((u): u is string => Boolean(u)),
    }));
  }

  async addWebhook(refreshToken: string, account: GoogleAdsAccount, form: GoogleLeadForm, webhook: { url: string; key: string }): Promise<void> {
    // Callers skip forms that deliver to another system: Google does not
    // return that system's secret, so rewriting its entry would break it.
    if (form.webhookUrls.some((url) => url !== webhook.url)) {
      throw new ConnectorError("This form already sends leads to another system", { retryable: false, providerCode: "other_webhook" });
    }
    const access = await this.accessToken(refreshToken);
    await this.ads(access, `customers/${account.customerId}/assets:mutate`, {
      method: "POST",
      loginCustomerId: account.loginCustomerId,
      body: {
        operations: [{
          update: {
            resourceName: form.resourceName,
            leadFormAsset: { deliveryMethods: [{ webhook: { advertiserWebhookUrl: webhook.url, googleSecret: webhook.key, payloadSchemaVersion: 3 } }] },
          },
          updateMask: "lead_form_asset.delivery_methods",
        }],
      },
    });
  }
}

/** Demo mode: no Google sign-in; one made-up account with two lead forms. */
export class MockGoogleOAuthClient implements GoogleOAuthClient {
  readonly mode = "mock" as const;
  readonly webhooks = new Map<string, string>();
  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    // A path, not a full URL: the browser stays on whichever address it is
    // using (a dev server on another port than PUBLIC_WEB_URL, say).
    const url = new URL(redirectUri);
    url.searchParams.set("code", "mock-google-code");
    url.searchParams.set("state", state);
    return `${url.pathname}${url.search}`;
  }
  async exchangeCode({ code }: { code: string }): Promise<string> {
    if (code !== "mock-google-code") throw new ConnectorError("Unknown code", { retryable: false, providerCode: "oauth" });
    return "mock-google-refresh-token";
  }
  async listAccounts(): Promise<GoogleAdsAccount[]> {
    return [{ customerId: "1234567890", name: "Demo Skin Clinic Ads", loginCustomerId: null }];
  }
  async listLeadForms(): Promise<GoogleLeadForm[]> {
    return [
      { resourceName: "customers/1234567890/assets/111", id: "111", name: "Free consultation form", webhookUrls: this.urlsFor("111") },
      { resourceName: "customers/1234567890/assets/222", id: "222", name: "Laser offer form", webhookUrls: this.urlsFor("222") },
    ];
  }
  private urlsFor(id: string): string[] {
    const url = this.webhooks.get(id);
    return url ? [url] : [];
  }
  async addWebhook(_refreshToken: string, _account: GoogleAdsAccount, form: GoogleLeadForm, webhook: { url: string; key: string }): Promise<void> {
    this.webhooks.set(form.id, webhook.url);
  }
}
