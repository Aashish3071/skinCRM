import { graphRequest, type FetchLike } from "../graph";

/**
 * Meta Conversions API for CRM leads (PRD FB-09).
 *
 * Only what the allowlist permits reaches here: the event name, time, a
 * stable event id and the Meta lead id (or WhatsApp referral id). No names,
 * contact details, services or notes — the builder in the API cannot put them
 * in, and this adapter has no field for them either.
 */
export interface CapiEvent {
  eventName: string;
  eventTime: Date;
  eventId: string;
  leadId?: string | null;
  whatsappReferralId?: string | null;
}

export interface CapiResult {
  accepted: number;
  traceId: string | null;
}

export interface MetaCapiConnector {
  readonly mode: "mock" | "live";
  send(params: { datasetId: string; accessToken: string; events: CapiEvent[]; testEventCode?: string | null }): Promise<CapiResult>;
}

export function capiPayload(events: CapiEvent[], testEventCode?: string | null) {
  return {
    data: events.map((e) => ({
      event_name: e.eventName,
      event_time: Math.floor(e.eventTime.getTime() / 1000),
      event_id: e.eventId,
      action_source: "system_generated",
      user_data: {
        ...(e.leadId ? { lead_id: e.leadId } : {}),
        ...(e.whatsappReferralId ? { ctwa_clid: e.whatsappReferralId } : {}),
      },
      custom_data: { event_source: "crm", lead_event_source: "SkinCRM" },
    })),
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}

export class LiveMetaCapiConnector implements MetaCapiConnector {
  readonly mode = "live" as const;
  constructor(private readonly fetchImpl: FetchLike = fetch) {}
  async send({ datasetId, accessToken, events, testEventCode }: { datasetId: string; accessToken: string; events: CapiEvent[]; testEventCode?: string | null }): Promise<CapiResult> {
    const r = await graphRequest<{ events_received?: number; fbtrace_id?: string }>(this.fetchImpl, `${datasetId}/events`, accessToken, {
      method: "POST",
      body: capiPayload(events, testEventCode),
    });
    return { accepted: r.events_received ?? 0, traceId: r.fbtrace_id ?? null };
  }
}

export class MockMetaCapiConnector implements MetaCapiConnector {
  readonly mode = "mock" as const;
  readonly sent: { datasetId: string; payload: unknown }[] = [];
  async send({ datasetId, events, testEventCode }: { datasetId: string; accessToken: string; events: CapiEvent[]; testEventCode?: string | null }): Promise<CapiResult> {
    this.sent.push({ datasetId, payload: capiPayload(events, testEventCode) });
    return { accepted: events.length, traceId: `mock-trace-${Date.now()}` };
  }
}
