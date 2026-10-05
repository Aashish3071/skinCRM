import { ConnectorError } from "../types";
import { graphRequest, type FetchLike } from "../graph";

export interface MetaDataset { id: string; name: string; businessId: string; businessName: string }
export interface MetaAdAttribution { accountId: string | null; campaignId: string | null; campaignName: string | null; adsetId: string | null; adId: string }
export interface MetaAdvertisingClient {
  readonly mode: "mock" | "live";
  listDatasets(token: string): Promise<MetaDataset[]>;
  ensureWhatsAppDataset(wabaId: string, token: string): Promise<string>;
  fetchAd(adId: string, token: string): Promise<MetaAdAttribution>;
}

/** Cursor pagination keeps access tokens out of URLs and rejects incomplete inventories. */
async function all<T>(fetchImpl: FetchLike, path: string, token: string): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (let n = 0; n < 100; n++) {
    const page = await graphRequest<{ data?: T[]; paging?: { next?: string; cursors?: { after?: string } } }>(
      fetchImpl, `${path}${after ? `&after=${encodeURIComponent(after)}` : ""}`, token,
    );
    rows.push(...(page.data ?? []));
    if (!page.paging?.next) return rows;
    const next = page.paging.cursors?.after;
    if (!next || next === after) break;
    after = next;
  }
  throw new ConnectorError("Meta returned too many assets. Narrow the businesses shared with SkinCRM and try again.", { retryable: false });
}

export class LiveMetaAdvertisingClient implements MetaAdvertisingClient {
  readonly mode = "live" as const;
  constructor(private readonly fetchImpl: FetchLike = fetch) {}
  async listDatasets(token: string): Promise<MetaDataset[]> {
    const businesses = await all<{ id: string; name: string }>(this.fetchImpl, "me/businesses?fields=id,name&limit=100", token);
    const datasets = new Map<string, MetaDataset>();
    for (const business of businesses) {
      for (const edge of ["owned_pixels", "client_pixels"]) {
        const rows = await all<{ id: string; name: string }>(this.fetchImpl, `${business.id}/${edge}?fields=id,name&limit=100`, token);
        for (const row of rows) datasets.set(row.id, { ...row, businessId: business.id, businessName: business.name });
      }
    }
    return [...datasets.values()];
  }
  async ensureWhatsAppDataset(wabaId: string, token: string): Promise<string> {
    if (!/^\d+$/.test(wabaId)) throw new ConnectorError("Invalid WhatsApp business account", { retryable: false });
    const result = await graphRequest<{ id?: string }>(this.fetchImpl, `${wabaId}/dataset`, token, { method: "POST" });
    if (!result.id) throw new ConnectorError("Meta did not return the WhatsApp conversion dataset", { retryable: false });
    return result.id;
  }
  async fetchAd(adId: string, token: string): Promise<MetaAdAttribution> {
    if (!/^\d+$/.test(adId)) throw new ConnectorError("Invalid ad id", { retryable: false });
    const ad = await graphRequest<{ id: string; account_id?: string; adset_id?: string; campaign?: { id?: string; name?: string } }>(
      this.fetchImpl, `${adId}?fields=id,account_id,adset_id,campaign{id,name}`, token,
    );
    return { adId: ad.id, accountId: ad.account_id ?? null, adsetId: ad.adset_id ?? null, campaignId: ad.campaign?.id ?? null, campaignName: ad.campaign?.name ?? null };
  }
}

export class MockMetaAdvertisingClient implements MetaAdvertisingClient {
  readonly mode = "mock" as const;
  async listDatasets(): Promise<MetaDataset[]> {
    return [{ id: "900000000000003", name: "Demo CRM outcomes", businessId: "900000000000004", businessName: "Demo Skin Clinic" }];
  }
  async ensureWhatsAppDataset(): Promise<string> { return "900000000000008"; }
  async fetchAd(adId: string): Promise<MetaAdAttribution> {
    return { adId, accountId: "900000000000005", campaignId: "900000000000006", campaignName: "Demo consultation campaign", adsetId: "900000000000007" };
  }
}
