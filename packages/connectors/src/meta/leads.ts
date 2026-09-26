import { ConnectorError } from "../types";
import { graphRequest, type FetchLike } from "../graph";

/**
 * Meta Lead Ads (PRD INT-01, INT-05).
 *
 * The leadgen webhook only says "lead 123 arrived on page 456"; the answers
 * themselves are fetched with the page's access token. That fetch is what this
 * adapter does.
 */
export interface MetaLead {
  id: string;
  createdTime: string | null;
  /** Question → answers, as the form defined them. */
  fields: Record<string, string>;
  formId: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  isOrganic: boolean;
}

export interface MetaLeadsConnector {
  readonly mode: "mock" | "live";
  fetchLead(leadgenId: string, accessToken: string): Promise<MetaLead>;
  /** Confirms the token works for this page; returns its name. */
  verifyPage(pageId: string, accessToken: string): Promise<{ ok: boolean; name: string | null; detail: string }>;
}

interface GraphLead {
  id: string;
  created_time?: string;
  field_data?: { name: string; values: string[] }[];
  form_id?: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  is_organic?: boolean;
}

export class LiveMetaLeadsConnector implements MetaLeadsConnector {
  readonly mode = "live" as const;
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetchLead(leadgenId: string, accessToken: string): Promise<MetaLead> {
    if (!/^\d+$/.test(leadgenId)) throw new ConnectorError("Invalid lead id", { retryable: false });
    const lead = await graphRequest<GraphLead>(
      this.fetchImpl,
      `${leadgenId}?fields=created_time,field_data,form_id,ad_id,adset_id,campaign_id,is_organic`,
      accessToken,
    );
    return toMetaLead(lead);
  }

  async verifyPage(pageId: string, accessToken: string) {
    try {
      const page = await graphRequest<{ id: string; name?: string }>(this.fetchImpl, `${pageId}?fields=id,name`, accessToken);
      return { ok: true, name: page.name ?? null, detail: "Connected to the page" };
    } catch (error) {
      return { ok: false, name: null, detail: error instanceof Error ? error.message : "Could not verify" };
    }
  }
}

export function toMetaLead(lead: GraphLead): MetaLead {
  const fields: Record<string, string> = {};
  for (const f of lead.field_data ?? []) fields[f.name] = (f.values ?? []).join(", ");
  return {
    id: lead.id,
    createdTime: lead.created_time ?? null,
    fields,
    formId: lead.form_id ?? null,
    adId: lead.ad_id ?? null,
    adsetId: lead.adset_id ?? null,
    campaignId: lead.campaign_id ?? null,
    isOrganic: lead.is_organic ?? false,
  };
}

/**
 * Returns a believable lead for any id, so the whole path — webhook, queue,
 * fetch, match, create — runs end to end without a Meta account.
 */
export class MockMetaLeadsConnector implements MetaLeadsConnector {
  readonly mode = "mock" as const;
  async fetchLead(leadgenId: string): Promise<MetaLead> {
    const n = leadgenId.slice(-4).padStart(4, "0");
    return {
      id: leadgenId,
      createdTime: new Date().toISOString(),
      fields: {
        full_name: `Meta Test Lead ${n}`,
        email: `meta.lead.${n}@example.test`,
        phone_number: `+1305556${n}`,
        "what_treatment_are_you_interested_in?": "Consultation",
      },
      formId: "mock-form-1",
      adId: "mock-ad-1",
      adsetId: "mock-adset-1",
      campaignId: "mock-campaign-1",
      isOrganic: false,
    };
  }
  async verifyPage() {
    return { ok: true, name: "Mock page", detail: "Mock Meta connector — nothing leaves this process." };
  }
}
