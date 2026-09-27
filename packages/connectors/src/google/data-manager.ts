import { ConnectorError } from "../types";
import type { FetchLike } from "../graph";

/**
 * Google Ads offline conversions through the Data Manager API (PRD FB-08).
 *
 * Click-ID only (gclid). No hashed email or phone and no enhanced conversions:
 * Google's customer-data policy forbids measuring health or medical conversions
 * that way (PRD 4.5a).
 *
 * VERIFY BEFORE GO-LIVE: the request shape follows Google's Data Manager
 * `events:ingest` documentation at the time of writing. Run the destination in
 * test mode (validate-only) against the real account first — the Settings
 * screen will not let it go live until a test succeeds.
 */
export interface GoogleConversion {
  conversionActionId: string;
  gclid: string;
  eventTime: Date;
  eventId: string;
}

export interface GoogleCredentials {
  customerId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId?: string | null;
}

export interface GoogleFeedbackConnector {
  readonly mode: "mock" | "live";
  send(params: { credentials: GoogleCredentials; conversions: GoogleConversion[]; validateOnly: boolean }): Promise<{ accepted: number; requestId: string | null }>;
}

export function dataManagerPayload(customerId: string, conversions: GoogleConversion[], validateOnly: boolean) {
  const account = customerId.replace(/-/g, "");
  return {
    destinations: [...new Set(conversions.map((c) => c.conversionActionId))].map((id) => ({
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: account },
      productDestinationId: id,
    })),
    events: conversions.map((c) => ({
      destinationReferences: [c.conversionActionId],
      transactionId: c.eventId,
      eventTimestamp: c.eventTime.toISOString(),
      adIdentifiers: { gclid: c.gclid },
    })),
    validateOnly,
  };
}

export class LiveGoogleFeedbackConnector implements GoogleFeedbackConnector {
  readonly mode = "live" as const;
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async accessToken(c: GoogleCredentials): Promise<string> {
    const r = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await r.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!r.ok || !data.access_token) {
      throw new ConnectorError(`Google sign-in failed: ${data.error_description ?? r.status}`, { retryable: r.status >= 500 });
    }
    return data.access_token;
  }

  async send({ credentials, conversions, validateOnly }: { credentials: GoogleCredentials; conversions: GoogleConversion[]; validateOnly: boolean }) {
    const token = await this.accessToken(credentials);
    const r = await this.fetchImpl("https://datamanager.googleapis.com/v1/events:ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(credentials.loginCustomerId ? { "login-customer-id": credentials.loginCustomerId.replace(/-/g, "") } : {}),
      },
      body: JSON.stringify(dataManagerPayload(credentials.customerId, conversions, validateOnly)),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await r.json().catch(() => ({}))) as { requestId?: string; error?: { message?: string; code?: number } };
    if (!r.ok) {
      throw new ConnectorError(data.error?.message ?? `Google returned ${r.status}`, { retryable: r.status >= 500 || r.status === 429, providerCode: String(r.status) });
    }
    return { accepted: conversions.length, requestId: data.requestId ?? null };
  }
}

export class MockGoogleFeedbackConnector implements GoogleFeedbackConnector {
  readonly mode = "mock" as const;
  readonly sent: unknown[] = [];
  async send({ credentials, conversions, validateOnly }: { credentials: GoogleCredentials; conversions: GoogleConversion[]; validateOnly: boolean }) {
    this.sent.push(dataManagerPayload(credentials.customerId, conversions, validateOnly));
    return { accepted: conversions.length, requestId: `mock-${Date.now()}` };
  }
}
