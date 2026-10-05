import { ConnectorError } from "../types";
import { GRAPH_BASE, graphRequest, type FetchLike } from "../graph";
import { GOOGLE_ADS_API_VERSION } from "../oauth/google";

/**
 * Managing the clinic's ad accounts from SkinCRM (D-95): campaigns and their
 * spend, pausing/resuming and daily budgets, customer-list audiences, and
 * past lead-form submissions. Money is in micros (1/1,000,000 of the account
 * currency) everywhere, as Google does; Meta's minor units are converted here.
 */
export type AdPlatform = "meta" | "google";

export interface AdAccount { id: string; name: string; currency: string }

export interface AdCampaign {
  id: string;
  name: string;
  status: "active" | "paused" | "other";
  /** Null when the budget lives on ad sets or is shared, so it can't be edited here. */
  dailyBudgetMicros: number | null;
  currency: string;
}

export interface AdSpendRow { date: string; campaignId: string; campaignName: string; spendMicros: number; impressions: number; clicks: number }

/** Hashed identifiers (SHA-256 hex of normalised email / E.164 digits). */
export interface AudienceMember { emailSha256: string | null; phoneSha256: string | null }

export interface HistoricLead {
  externalId: string;
  submittedAt: Date;
  /** Meta: lead ids to fetch through the normal path. Google: the answers inline. */
  formId: string | null;
  campaignId: string | null;
  gclid: string | null;
  fields: { columnId: string; value: string }[];
}

/** Who to act as: Meta needs a user token and ad account; Google a refresh token and customer. */
export interface AdCredentials {
  accessToken: string;
  accountId: string;
  loginCustomerId?: string | null;
}

export interface AdsClient {
  readonly platform: AdPlatform;
  readonly mode: "mock" | "live";
  listAccounts(accessToken: string): Promise<AdAccount[]>;
  listCampaigns(c: AdCredentials): Promise<AdCampaign[]>;
  dailySpend(c: AdCredentials, from: string, to: string): Promise<AdSpendRow[]>;
  setCampaignActive(c: AdCredentials, campaignId: string, active: boolean): Promise<void>;
  setDailyBudget(c: AdCredentials, campaignId: string, micros: number): Promise<void>;
  createAudience(c: AdCredentials, name: string, description: string): Promise<string>;
  /** Make the audience exactly these members. */
  replaceAudience(c: AdCredentials, audienceId: string, members: AudienceMember[]): Promise<void>;
  deleteAudience(c: AdCredentials, audienceId: string): Promise<void>;
}

// --- Meta Marketing API ---------------------------------------------------------

/** Most currencies have 2 decimals; Meta counts these in their minor unit. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "COP", "HUF", "ISK", "IDR", "PYG", "TWD", "VND"]);
const minorToMicros = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency) ? minor * 1_000_000 : minor * 10_000);
const microsToMinor = (micros: number, currency: string) => Math.round(ZERO_DECIMAL.has(currency) ? micros / 1_000_000 : micros / 10_000);

async function graphAll<T>(fetchImpl: FetchLike, path: string, token: string, max = 20): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < max; page++) {
    const r: { data?: T[]; paging?: { next?: string } } = await graphRequest(fetchImpl, next, token);
    out.push(...(r.data ?? []));
    next = r.paging?.next ? r.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, "") : null;
  }
  return out;
}

const act = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);
const digits = (id: string) => {
  if (!/^(act_)?\d+$/.test(id)) throw new ConnectorError("Invalid account or object id", { retryable: false });
  return id;
};

export class MetaAdsClient implements AdsClient {
  readonly platform = "meta" as const;
  readonly mode = "live" as const;
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async listAccounts(token: string): Promise<AdAccount[]> {
    const rows = await graphAll<{ id: string; name?: string; currency?: string; account_status?: number }>(this.fetchImpl, "me/adaccounts?fields=id,name,currency,account_status&limit=100", token);
    return rows.filter((r) => r.account_status !== 2 && r.account_status !== 101).map((r) => ({ id: r.id, name: r.name ?? r.id, currency: r.currency ?? "USD" }));
  }

  private async currency(c: AdCredentials): Promise<string> {
    const r = await graphRequest<{ currency?: string }>(this.fetchImpl, `${act(digits(c.accountId))}?fields=currency`, c.accessToken);
    return r.currency ?? "USD";
  }

  async listCampaigns(c: AdCredentials): Promise<AdCampaign[]> {
    const currency = await this.currency(c);
    const rows = await graphAll<{ id: string; name: string; status: string; daily_budget?: string }>(this.fetchImpl,
      `${act(digits(c.accountId))}/campaigns?fields=id,name,status,daily_budget&limit=200`, c.accessToken);
    return rows.filter((r) => r.status !== "DELETED" && r.status !== "ARCHIVED").map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status === "ACTIVE" ? "active" : r.status === "PAUSED" ? "paused" : "other",
      dailyBudgetMicros: r.daily_budget ? minorToMicros(Number(r.daily_budget), currency) : null,
      currency,
    }));
  }

  async dailySpend(c: AdCredentials, from: string, to: string): Promise<AdSpendRow[]> {
    const range = encodeURIComponent(JSON.stringify({ since: from, until: to }));
    const rows = await graphAll<{ campaign_id: string; campaign_name: string; spend?: string; impressions?: string; clicks?: string; date_start: string }>(this.fetchImpl,
      `${act(digits(c.accountId))}/insights?level=campaign&time_increment=1&time_range=${range}&fields=campaign_id,campaign_name,spend,impressions,clicks&limit=500`, c.accessToken, 50);
    return rows.map((r) => ({
      date: r.date_start,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      spendMicros: Math.round(Number(r.spend ?? 0) * 1_000_000),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
    }));
  }

  async setCampaignActive(c: AdCredentials, campaignId: string, active: boolean) {
    await graphRequest(this.fetchImpl, digits(campaignId), c.accessToken, { method: "POST", body: { status: active ? "ACTIVE" : "PAUSED" } });
  }

  async setDailyBudget(c: AdCredentials, campaignId: string, micros: number) {
    const currency = await this.currency(c);
    await graphRequest(this.fetchImpl, digits(campaignId), c.accessToken, { method: "POST", body: { daily_budget: microsToMinor(micros, currency) } });
  }

  async createAudience(c: AdCredentials, name: string, description: string) {
    const r = await graphRequest<{ id: string }>(this.fetchImpl, `${act(digits(c.accountId))}/customaudiences`, c.accessToken, {
      method: "POST",
      body: { name, description, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY" },
    });
    return r.id;
  }

  async replaceAudience(c: AdCredentials, audienceId: string, members: AudienceMember[]) {
    const rows = members.filter((m) => m.emailSha256 || m.phoneSha256).map((m) => [m.emailSha256 ?? "", m.phoneSha256 ?? ""]);
    const sessionId = Number(String(Date.now()).slice(-9));
    const batches = Math.max(1, Math.ceil(rows.length / 10_000));
    for (let i = 0; i < batches; i++) {
      await graphRequest(this.fetchImpl, `${digits(audienceId)}/usersreplace`, c.accessToken, {
        method: "POST",
        body: {
          session: { session_id: sessionId, batch_seq: i + 1, last_batch_flag: i === batches - 1, estimated_num_total: rows.length },
          payload: { schema: ["EMAIL", "PHONE"], data: rows.slice(i * 10_000, (i + 1) * 10_000) },
        },
      });
    }
  }

  async deleteAudience(c: AdCredentials, audienceId: string) {
    const response = await this.fetchImpl(`${GRAPH_BASE}/${digits(audienceId)}`, { method: "DELETE", headers: { authorization: `Bearer ${c.accessToken}` } });
    if (!response.ok && response.status !== 404) throw new ConnectorError(`Meta returned ${response.status}`, { retryable: response.status >= 500, providerCode: String(response.status) });
  }

  /** Past lead-form submissions on a Page, newest first, since a date. */
  async pageLeadsSince(pageId: string, pageToken: string, since: Date): Promise<HistoricLead[]> {
    const forms = await graphAll<{ id: string }>(this.fetchImpl, `${digits(pageId)}/leadgen_forms?fields=id&limit=100`, pageToken);
    const filter = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since.getTime() / 1000) }]));
    const out: HistoricLead[] = [];
    for (const form of forms) {
      const leads = await graphAll<{ id: string; created_time: string }>(this.fetchImpl, `${form.id}/leads?fields=id,created_time&filtering=${filter}&limit=500`, pageToken, 50);
      for (const l of leads) out.push({ externalId: l.id, submittedAt: new Date(l.created_time), formId: form.id, campaignId: null, gclid: null, fields: [] });
    }
    return out;
  }
}

// --- Google Ads API --------------------------------------------------------------

export class GoogleAdsClient implements AdsClient {
  readonly platform = "google" as const;
  readonly mode = "live" as const;
  constructor(private readonly app: { clientId: string; clientSecret: string; developerToken?: string }, private readonly fetchImpl: FetchLike = fetch) {}

  /** The caller passes a refresh token as accessToken; this swaps it for a real one. */
  private async token(refreshToken: string): Promise<string> {
    const r = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await r.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!r.ok || !data.access_token) throw new ConnectorError(data.error_description ?? "Google sign-in expired. Reconnect Google Ads.", { retryable: false, providerCode: "oauth" });
    return data.access_token;
  }

  private async call<T>(c: AdCredentials, path: string, body?: unknown): Promise<T> {
    const access = await this.token(c.accessToken);
    const response = await this.fetchImpl(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${access}`,
        ...(this.app.developerToken ? { "developer-token": this.app.developerToken } : {}),
        ...(c.loginCustomerId ? { "login-customer-id": c.loginCustomerId } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
    if (!response.ok) {
      throw new ConnectorError(data.error?.message ?? `Google Ads returned ${response.status}`, { retryable: response.status >= 500 || response.status === 429, providerCode: data.error?.status ?? String(response.status) });
    }
    return data;
  }

  private async search<T>(c: AdCredentials, query: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.call<{ results?: T[]; nextPageToken?: string }>(c, `customers/${c.accountId}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) });
      out.push(...(r.results ?? []));
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return out;
  }

  async listAccounts(): Promise<AdAccount[]> {
    return []; // The connected customer is chosen in Connect with Google Ads.
  }

  async listCampaigns(c: AdCredentials): Promise<AdCampaign[]> {
    const rows = await this.search<{ campaign: { id: string; name: string; status: string }; campaignBudget?: { amountMicros?: string; explicitlyShared?: boolean }; customer?: { currencyCode?: string } }>(c,
      "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.explicitly_shared, customer.currency_code FROM campaign WHERE campaign.status != 'REMOVED'");
    return rows.map((r) => ({
      id: String(r.campaign.id),
      name: r.campaign.name,
      status: r.campaign.status === "ENABLED" ? "active" : r.campaign.status === "PAUSED" ? "paused" : "other",
      dailyBudgetMicros: r.campaignBudget?.amountMicros && !r.campaignBudget.explicitlyShared ? Number(r.campaignBudget.amountMicros) : null,
      currency: r.customer?.currencyCode ?? "USD",
    }));
  }

  async dailySpend(c: AdCredentials, from: string, to: string): Promise<AdSpendRow[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ConnectorError("Bad date", { retryable: false });
    const rows = await this.search<{ campaign: { id: string; name: string }; segments: { date: string }; metrics: { costMicros?: string; impressions?: string; clicks?: string } }>(c,
      `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`);
    return rows.map((r) => ({
      date: r.segments.date,
      campaignId: String(r.campaign.id),
      campaignName: r.campaign.name,
      spendMicros: Number(r.metrics.costMicros ?? 0),
      impressions: Number(r.metrics.impressions ?? 0),
      clicks: Number(r.metrics.clicks ?? 0),
    }));
  }

  async setCampaignActive(c: AdCredentials, campaignId: string, active: boolean) {
    digits(campaignId);
    await this.call(c, `customers/${c.accountId}/campaigns:mutate`, {
      operations: [{ update: { resourceName: `customers/${c.accountId}/campaigns/${campaignId}`, status: active ? "ENABLED" : "PAUSED" }, updateMask: "status" }],
    });
  }

  async setDailyBudget(c: AdCredentials, campaignId: string, micros: number) {
    digits(campaignId);
    const [row] = await this.search<{ campaignBudget: { resourceName: string; explicitlyShared?: boolean } }>(c,
      `SELECT campaign_budget.resource_name, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${campaignId}`);
    if (!row) throw new ConnectorError("Campaign not found", { retryable: false, providerCode: "404" });
    if (row.campaignBudget.explicitlyShared) throw new ConnectorError("This campaign uses a shared budget. Change it in Google Ads.", { retryable: false, providerCode: "shared_budget" });
    await this.call(c, `customers/${c.accountId}/campaignBudgets:mutate`, {
      operations: [{ update: { resourceName: row.campaignBudget.resourceName, amountMicros: String(Math.round(micros / 10_000) * 10_000) }, updateMask: "amount_micros" }],
    });
  }

  async createAudience(c: AdCredentials, name: string, description: string) {
    const r = await this.call<{ results: { resourceName: string }[] }>(c, `customers/${c.accountId}/userLists:mutate`, {
      operations: [{ create: { name, description, membershipLifeSpan: 540, crmBasedUserList: { uploadKeyType: "CONTACT_INFO", dataSourceType: "FIRST_PARTY" } } }],
    });
    return r.results[0]!.resourceName.split("/").pop()!;
  }

  async replaceAudience(c: AdCredentials, audienceId: string, members: AudienceMember[]) {
    digits(audienceId);
    const job = await this.call<{ resourceName: string }>(c, `customers/${c.accountId}/offlineUserDataJobs:create`, {
      job: {
        type: "CUSTOMER_MATCH_USER_LIST",
        customerMatchUserListMetadata: { userList: `customers/${c.accountId}/userLists/${audienceId}`, consent: { adUserData: "GRANTED", adPersonalization: "GRANTED" } },
      },
    });
    const creates = members.filter((m) => m.emailSha256 || m.phoneSha256).map((m) => ({
      create: { userIdentifiers: [...(m.emailSha256 ? [{ hashedEmail: m.emailSha256 }] : []), ...(m.phoneSha256 ? [{ hashedPhoneNumber: m.phoneSha256 }] : [])] },
    }));
    // First empty the list, then add the current members, in batches.
    await this.call(c, `${job.resourceName}:addOperations`, { enablePartialFailure: true, operations: [{ removeAll: true }] });
    for (let i = 0; i < creates.length; i += 10_000) {
      await this.call(c, `${job.resourceName}:addOperations`, { enablePartialFailure: true, operations: creates.slice(i, i + 10_000) });
    }
    await this.call(c, `${job.resourceName}:run`, {});
  }

  async deleteAudience(c: AdCredentials, audienceId: string) {
    digits(audienceId);
    await this.call(c, `customers/${c.accountId}/userLists:mutate`, { operations: [{ remove: `customers/${c.accountId}/userLists/${audienceId}` }] });
  }

  /** Past lead-form submissions since a date, with their answers. */
  async leadsSince(c: AdCredentials, since: Date): Promise<HistoricLead[]> {
    const stamp = since.toISOString().replace("T", " ").slice(0, 19);
    const rows = await this.search<{ leadFormSubmissionData: { id: string; gclid?: string; submissionDateTime: string; campaign?: string; asset?: string; leadFormSubmissionFields?: { fieldType: string; fieldValue: string }[] } }>(c,
      `SELECT lead_form_submission_data.id, lead_form_submission_data.gclid, lead_form_submission_data.submission_date_time, lead_form_submission_data.campaign, lead_form_submission_data.asset, lead_form_submission_data.lead_form_submission_fields FROM lead_form_submission_data WHERE lead_form_submission_data.submission_date_time >= '${stamp}'`);
    return rows.map(({ leadFormSubmissionData: d }) => ({
      externalId: String(d.id),
      submittedAt: new Date(d.submissionDateTime.replace(" ", "T").replace(/([+-]\d{2}:\d{2})?$/, (z) => z || "Z")),
      formId: d.asset?.split("/").pop() ?? null,
      campaignId: d.campaign?.split("/").pop() ?? null,
      gclid: d.gclid ?? null,
      fields: (d.leadFormSubmissionFields ?? []).map((f) => ({ columnId: f.fieldType, value: f.fieldValue })),
    }));
  }
}

// --- Demo ------------------------------------------------------------------------

export class MockAdsClient implements AdsClient {
  readonly mode = "mock" as const;
  readonly campaigns: AdCampaign[];
  readonly audiences = new Map<string, { name: string; members: AudienceMember[] }>();
  readonly historic: HistoricLead[] = [];
  constructor(readonly platform: AdPlatform) {
    this.campaigns = platform === "meta"
      ? [
          { id: "120000000000001", name: "Spring skin consult — Leads", status: "active", dailyBudgetMicros: 40_000_000, currency: "USD" },
          { id: "120000000000002", name: "Laser offer — Messages", status: "paused", dailyBudgetMicros: 25_000_000, currency: "USD" },
        ]
      : [
          { id: "21000000001", name: "Search — Dermatologist near me", status: "active", dailyBudgetMicros: 60_000_000, currency: "USD" },
          { id: "21000000002", name: "Lead form — Free consult", status: "active", dailyBudgetMicros: null, currency: "USD" },
        ];
  }
  async listAccounts(): Promise<AdAccount[]> {
    return this.platform === "meta" ? [{ id: "act_100000000000001", name: "Demo Clinic Ads", currency: "USD" }] : [];
  }
  async listCampaigns() {
    return this.campaigns.map((c) => ({ ...c }));
  }
  async dailySpend(_c: AdCredentials, from: string, to: string): Promise<AdSpendRow[]> {
    const rows: AdSpendRow[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
      this.campaigns.forEach((c, i) => {
        if (c.status !== "active") return;
        rows.push({ date: d.toISOString().slice(0, 10), campaignId: c.id, campaignName: c.name, spendMicros: (20 + i * 7) * 1_000_000, impressions: 1200 + i * 300, clicks: 30 + i * 5 });
      });
    }
    return rows;
  }
  async setCampaignActive(_c: AdCredentials, id: string, active: boolean) {
    const c = this.campaigns.find((x) => x.id === id);
    if (!c) throw new ConnectorError("Campaign not found", { retryable: false, providerCode: "404" });
    c.status = active ? "active" : "paused";
  }
  async setDailyBudget(_c: AdCredentials, id: string, micros: number) {
    const c = this.campaigns.find((x) => x.id === id);
    if (!c) throw new ConnectorError("Campaign not found", { retryable: false, providerCode: "404" });
    if (c.dailyBudgetMicros === null) throw new ConnectorError("This campaign's budget is set on its ad sets or shared.", { retryable: false, providerCode: "shared_budget" });
    c.dailyBudgetMicros = micros;
  }
  async createAudience(_c: AdCredentials, name: string) {
    const id = `${this.platform === "meta" ? "2385" : "88"}${String(this.audiences.size + 1).padStart(8, "0")}`;
    this.audiences.set(id, { name, members: [] });
    return id;
  }
  async replaceAudience(_c: AdCredentials, id: string, members: AudienceMember[]) {
    const a = this.audiences.get(id);
    if (!a) throw new ConnectorError("Audience not found", { retryable: false, providerCode: "404" });
    a.members = members;
  }
  async deleteAudience(_c: AdCredentials, id: string) {
    this.audiences.delete(id);
  }
  async pageLeadsSince(): Promise<HistoricLead[]> {
    return this.historic;
  }
  async leadsSince(): Promise<HistoricLead[]> {
    return this.historic;
  }
}
