import { describe, expect, it } from "vitest";
import { LiveMetaAdvertisingClient } from "./meta/advertising";
import { capiPayload } from "./meta/capi";
import { LiveGoogleFeedbackConnector, dataManagerPayload } from "./google/data-manager";
import { LiveGoogleOAuthClient } from "./oauth/google";
import { LiveWhatsAppSignupClient } from "./oauth/whatsapp";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const event = { eventName: "LeadSubmitted", eventTime: new Date("2026-10-01T00:00:00Z"), eventId: "stable-event", whatsappReferralId: "ctwa-real-id", whatsappBusinessAccountId: "1234567890" };
const credentials = { customerId: "123-456-7890", clientId: "client", clientSecret: "secret", refreshToken: "refresh", loginCustomerId: "111-222-3333" };
const conversion = { conversionActionId: "456", gclid: "click", eventTime: event.eventTime, eventId: event.eventId };

describe("channel-specific conversion payloads", () => {
  it("uses WhatsApp business messaging fields and never leaks arbitrary input", () => {
    const payload = capiPayload([{ ...event, phone: "secret phone", notes: "private" } as typeof event], "TEST");
    expect(payload.data[0]).toEqual({ event_name: "LeadSubmitted", event_time: 1790812800, event_id: "stable-event", action_source: "business_messaging", messaging_channel: "whatsapp", user_data: { ctwa_clid: "ctwa-real-id", whatsapp_business_account_id: "1234567890" } });
    expect(JSON.stringify(payload)).not.toMatch(/secret phone|private/);
  });
  it("refuses WhatsApp feedback without a WABA or with a custom CRM event name", () => {
    expect(() => capiPayload([{ ...event, whatsappBusinessAccountId: null }])).toThrow(/Connect/);
    expect(() => capiPayload([{ ...event, eventName: "BookedLead" }])).toThrow(/supported/);
  });
  it("keeps Meta form leads on the CRM matching path", () => {
    const payload = capiPayload([{ eventName: "BookedLead", eventTime: event.eventTime, eventId: "id", leadId: "lead" }]);
    expect(payload.data[0]).toMatchObject({ action_source: "system_generated", user_data: { lead_id: "lead" } });
    expect(payload.data[0]).not.toHaveProperty("messaging_channel");
  });
  it("adds destination references and puts manager routing in the Data Manager body", () => {
    const body = dataManagerPayload(credentials.customerId, [conversion], true, credentials.loginCustomerId);
    expect(body.destinations[0]).toEqual({ reference: "456", productDestinationId: "456", operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" }, loginAccount: { accountType: "GOOGLE_ADS", accountId: "1112223333" } });
    expect(body.events[0]).toEqual({ destinationReferences: ["456"], transactionId: "stable-event", eventTimestamp: "2026-10-01T00:00:00.000Z", adIdentifiers: { gclid: "click" } });
  });
});

describe("Google upload diagnostics", () => {
  it("records asynchronous uploads and waits for provider processing", async () => {
    let status = "PROCESSING";
    const client = new LiveGoogleFeedbackConnector(async (url, init) => {
      if (url.includes("oauth2")) return json({ access_token: "access" });
      expect((init?.headers as Record<string, string>)["login-customer-id"]).toBeUndefined();
      if (url.includes("events:ingest")) return json({ requestId: "request" });
      return json({ requestStatusPerDestination: [{ requestStatus: status }] });
    });
    expect(await client.send({ credentials, conversions: [conversion], validateOnly: false })).toMatchObject({ pending: true, requestId: "request" });
    expect((await client.status(credentials, "request")).state).toBe("processing");
    status = "SUCCESS";
    expect((await client.status(credentials, "request")).state).toBe("accepted");
  });
  it("reports rejected clicks rather than counting them as accepted", async () => {
    const client = new LiveGoogleFeedbackConnector(async (url) => url.includes("oauth2") ? json({ access_token: "access" }) : json({ requestStatusPerDestination: [{ requestStatus: "FAILED", errorInfo: { errorCounts: [{ reason: "PROCESSING_ERROR_REASON_CLICK_NOT_FOUND" }] } }] }));
    expect(await client.status(credentials, "request")).toEqual({ state: "rejected", detail: "PROCESSING_ERROR_REASON_CLICK_NOT_FOUND" });
  });
  it("validates without a request ID but refuses a production response missing it", async () => {
    const client = new LiveGoogleFeedbackConnector(async (url) => url.includes("oauth2") ? json({ access_token: "access" }) : json({}));
    expect((await client.send({ credentials, conversions: [conversion], validateOnly: true })).pending).toBe(false);
    await expect(client.send({ credentials, conversions: [conversion], validateOnly: false })).rejects.toThrow(/request ID/);
  });
  it("preserves retry decisions for provider rate limits", async () => {
    const client = new LiveGoogleFeedbackConnector(async (url) => url.includes("oauth2") ? json({ access_token: "access" }) : json({ error: { message: "Rate limited" } }, 429));
    await expect(client.send({ credentials, conversions: [conversion], validateOnly: false })).rejects.toMatchObject({ options: { retryable: true } });
  });
});

describe("asset discovery and ownership", () => {
  it("follows Meta cursors without reusing provider URLs containing tokens", async () => {
    const client = new LiveMetaAdvertisingClient(async (url) => {
      expect(url).not.toContain("access_token");
      if (url.includes("me/businesses")) return json({ data: [{ id: "1", name: "Clinic" }] });
      if (url.includes("client_pixels")) return json({ data: [{ id: "2", name: "Shared dataset" }] });
      if (url.includes("after=")) return json({ data: [{ id: "3", name: "Next dataset" }] });
      return json({ data: [{ id: "2", name: "Dataset" }], paging: { next: "https://graph.facebook.com/unsafe?access_token=secret", cursors: { after: "cursor" } } });
    });
    expect((await client.listDatasets("secret")).map((d) => d.id)).toEqual(["2", "3"]);
  });
  it("creates or retrieves the dataset through the selected WABA", async () => {
    const client = new LiveMetaAdvertisingClient(async (url, init) => { expect(url).toContain("12345/dataset"); expect(init?.method).toBe("POST"); return json({ id: "99999" }); });
    expect(await client.ensureWhatsAppDataset("12345", "token")).toBe("99999");
    await expect(client.ensureWhatsAppDataset("../me", "token")).rejects.toThrow(/Invalid/);
  });
  it("reads campaign attribution from the ad rather than inventing campaign IDs", async () => {
    const client = new LiveMetaAdvertisingClient(async () => json({ id: "12345", account_id: "123", adset_id: "124", campaign: { id: "125", name: "Campaign" } }));
    expect(await client.fetchAd("12345", "token")).toEqual({ adId: "12345", accountId: "123", adsetId: "124", campaignId: "125", campaignName: "Campaign" });
  });
  it("checks number membership before trusting the browser's WABA selection", async () => {
    const client = new LiveWhatsAppSignupClient({ appId: "app", appSecret: "secret" }, async (url) => url.includes("phone_numbers") ? json({ data: [{ id: "22222" }] }) : json({ display_phone_number: "+13055550100" }));
    await expect(client.numberDetails("11111", "token", "33333")).rejects.toThrow(/does not belong/);
    expect((await client.numberDetails("22222", "token", "33333")).displayPhone).toBe("+13055550100");
  });
  it("discovers Google conversions with pagination and Data Manager permission", async () => {
    const client = new LiveGoogleOAuthClient({ clientId: "client", clientSecret: "secret" }, async (url, init) => {
      if (url.includes("oauth2")) return json({ access_token: "access" });
      expect(url).toContain("/v25/");
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain("UPLOAD_CLICKS");
      return body.pageToken ? json({ results: [{ conversionAction: { id: "2", name: "Won", ownerCustomer: "customers/1234567890" } }] }) : json({ results: [{ conversionAction: { id: "1", name: "Booked", ownerCustomer: "customers/1234567890" } }], nextPageToken: "next" });
    });
    expect(new URL(client.authorizeUrl({ state: "state", redirectUri: "https://crm.test/callback" })).searchParams.get("scope")).toContain("/auth/datamanager");
    expect((await client.listConversionActions("refresh", { customerId: "1234567890", name: "Clinic", loginCustomerId: null })).map((a) => a.id)).toEqual(["1", "2"]);
  });
});
