import { ConnectorError } from "../types";
import { GRAPH_BASE, GRAPH_VERSION, graphRequest, type FetchLike } from "../graph";

/**
 * "Connect with Facebook" (Facebook Login for Business).
 *
 * The clinic signs in on facebook.com and approves our app; we get a user
 * token, trade it for a long-lived one, list the Pages they manage (each with
 * its own Page token, which does not expire when derived from a long-lived
 * user token), and subscribe the chosen Page to our app's `leadgen` webhook.
 * Nobody copies an ID or a token by hand.
 *
 * Needs, once per deployment: a Meta app with Facebook Login for Business,
 * the permissions below approved in App Review (Advanced Access) and Business
 * Verification, the redirect URI registered, and the app's leadgen webhook
 * pointed at /webhooks/meta. See docs/DEPLOYMENT.md §4.
 */
export const META_OAUTH_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "leads_retrieval",
  "business_management",
] as const;

export interface MetaPageChoice {
  id: string;
  name: string;
  accessToken: string;
  /** False when the person lacks the Page role Meta requires to read leads. */
  canReadLeads: boolean;
}

export interface MetaOAuthClient {
  readonly mode: "mock" | "live";
  authorizeUrl(params: { state: string; redirectUri: string }): string;
  /** Code → long-lived user token. */
  exchangeCode(params: { code: string; redirectUri: string }): Promise<string>;
  listPages(userToken: string): Promise<MetaPageChoice[]>;
  /** Point the Page's lead events at our app's webhook. */
  subscribePage(pageId: string, pageToken: string): Promise<void>;
}

export class LiveMetaOAuthClient implements MetaOAuthClient {
  readonly mode = "live" as const;
  constructor(
    private readonly app: { appId: string; appSecret: string; loginConfigId?: string | null },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", this.app.appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    // A Login for Business configuration carries its own permission set.
    if (this.app.loginConfigId) url.searchParams.set("config_id", this.app.loginConfigId);
    else url.searchParams.set("scope", META_OAUTH_SCOPES.join(","));
    return url.toString();
  }

  /**
   * The token endpoint takes the app secret as a query parameter (Meta's
   * documented form). It is a server-to-server call and never logged.
   */
  private async tokenCall(params: Record<string, string>): Promise<string> {
    const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new ConnectorError(`Could not reach Facebook: ${error instanceof Error ? error.message : "network error"}`, { retryable: true, providerCode: "network" });
    }
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
    if (!response.ok || !data.access_token) {
      throw new ConnectorError(data.error?.message ?? `Facebook returned ${response.status}`, { retryable: false, providerCode: "oauth" });
    }
    return data.access_token;
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<string> {
    const short = await this.tokenCall({ client_id: this.app.appId, client_secret: this.app.appSecret, redirect_uri: redirectUri, code });
    return this.tokenCall({ grant_type: "fb_exchange_token", client_id: this.app.appId, client_secret: this.app.appSecret, fb_exchange_token: short });
  }

  async listPages(userToken: string): Promise<MetaPageChoice[]> {
    const pages: MetaPageChoice[] = [];
    let path: string | null = "me/accounts?fields=id,name,access_token,tasks&limit=100";
    for (let guard = 0; path && guard < 10; guard++) {
      const page: { data?: { id: string; name: string; access_token?: string; tasks?: string[] }[]; paging?: { next?: string } } =
        await graphRequest(this.fetchImpl, path, userToken);
      for (const p of page.data ?? []) {
        if (!p.access_token) continue;
        const tasks = p.tasks ?? [];
        pages.push({ id: p.id, name: p.name, accessToken: p.access_token, canReadLeads: tasks.includes("MANAGE") || tasks.includes("ADVERTISE") });
      }
      path = page.paging?.next ? page.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, "") : null;
    }
    return pages;
  }

  async subscribePage(pageId: string, pageToken: string): Promise<void> {
    if (!/^\d+$/.test(pageId)) throw new ConnectorError("Invalid page id", { retryable: false });
    await graphRequest(this.fetchImpl, `${pageId}/subscribed_apps?subscribed_fields=leadgen`, pageToken, { method: "POST" });
  }
}

/**
 * Demo mode: skips facebook.com (straight back to our callback) and offers two
 * made-up Pages, so the whole connect flow can be clicked through locally.
 */
export class MockMetaOAuthClient implements MetaOAuthClient {
  readonly mode = "mock" as const;
  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    // A path, not a full URL: the browser stays on whichever address it is
    // using (a dev server on another port than PUBLIC_WEB_URL, say).
    const url = new URL(redirectUri);
    url.searchParams.set("code", "mock-meta-code");
    url.searchParams.set("state", state);
    return `${url.pathname}${url.search}`;
  }
  async exchangeCode({ code }: { code: string }): Promise<string> {
    if (code !== "mock-meta-code") throw new ConnectorError("Unknown code", { retryable: false, providerCode: "oauth" });
    return "mock-long-lived-user-token";
  }
  async listPages(): Promise<MetaPageChoice[]> {
    return [
      { id: "900000000000001", name: "Demo Skin Clinic", accessToken: "mock-page-token-1", canReadLeads: true },
      { id: "900000000000002", name: "Demo Skin Clinic — Tampa", accessToken: "mock-page-token-2", canReadLeads: true },
    ];
  }
  async subscribePage(): Promise<void> {}
}
