import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { DEFAULT_FEEDBACK_MAPPING } from "@skincrm/contracts";
import { resetEnvCache } from "@skincrm/config";
import { LiveGoogleFeedbackConnector, MockGoogleFeedbackConnector, MockGoogleOAuthClient, MockMetaAdvertisingClient, MockMetaCapiConnector, MockMetaOAuthClient, setFeedbackConnectors, setMetaAdvertisingClient, setOAuthClients } from "@skincrm/connectors";
import { decryptForClinic } from "@skincrm/security";
import { SEED, authenticate, clinicIdBySlug, createTestApp, letters, resetAuthState } from "./helpers";
import { processDueInboundEvents } from "../integrations/processor";
import { processFeedbackOutbox } from "../feedback/service";
import { syncDueGoogleForms } from "../integrations/sync";

const TAG = "adsynctest";
const { integrationConnections, feedbackDestinations, feedbackEvents, sourceSubmissions, people, leads, inboundEvents } = schema;
let app: FastifyInstance;
let admin: string;
let clinicId: string;
let stageId: string;
let meta: MockMetaCapiConnector;
let google: MockGoogleOAuthClient;
let sequence = 0;
let savedConnections: (typeof integrationConnections.$inferSelect)[] = [];
let savedDestinations: (typeof feedbackDestinations.$inferSelect)[] = [];
const scope = () => eq(integrationConnections.clinicId, clinicId);
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>, cookie = admin) => app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
const ok = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) => {
  const response = await call(method, url, payload);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json();
};

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  savedConnections = await getOwnerDb().db.select().from(integrationConnections).where(scope());
  savedDestinations = await getOwnerDb().db.select().from(feedbackDestinations).where(eq(feedbackDestinations.clinicId, clinicId));
  stageId = (await ok("GET", "/pipeline/stages")).items.find((s: { category: string }) => s.category === "consultation_booked").id;
});
beforeEach(async () => {
  await getOwnerDb().db.delete(integrationConnections).where(scope());
  await getOwnerDb().db.delete(feedbackDestinations).where(eq(feedbackDestinations.clinicId, clinicId));
  meta = new MockMetaCapiConnector();
  google = new MockGoogleOAuthClient();
  setFeedbackConnectors({ meta, whatsapp: meta, google: new MockGoogleFeedbackConnector() });
  setMetaAdvertisingClient(new MockMetaAdvertisingClient());
  setOAuthClients({ meta: new MockMetaOAuthClient(), google });
  process.env.CONVERSION_FEEDBACK_ENABLED = "true";
  resetEnvCache();
});
afterEach(async () => {
  const { db } = getOwnerDb();
  const pids = (await db.select({ id: people.id }).from(people).where(like(people.displayName, `%${TAG}%`))).map((p) => p.id);
  const subs = pids.length ? (await db.select({ id: sourceSubmissions.id }).from(sourceSubmissions).where(inArray(sourceSubmissions.personId, pids))).map((s) => s.id) : [];
  if (pids.length) await db.delete(people).where(inArray(people.id, pids));
  if (subs.length) await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.id, subs));
  await db.delete(inboundEvents).where(like(inboundEvents.externalId, `${TAG}%`));
  delete process.env.CONVERSION_FEEDBACK_ENABLED;
  resetEnvCache();
});
afterAll(async () => {
  const { db } = getOwnerDb();
  await db.delete(integrationConnections).where(scope());
  await db.delete(feedbackDestinations).where(eq(feedbackDestinations.clinicId, clinicId));
  if (savedConnections.length) await db.insert(integrationConnections).values(savedConnections);
  if (savedDestinations.length) await db.insert(feedbackDestinations).values(savedDestinations);
  setFeedbackConnectors(undefined); setMetaAdvertisingClient(undefined); setOAuthClients(undefined);
  await app.close(); await closeAllConnections();
});

async function connect(provider: "meta" | "google") {
  const start = await ok("POST", `/integrations/oauth/${provider}/start`);
  const back = new URL(start.url, "http://web.test");
  const pending = await ok("POST", `/integrations/oauth/${provider}/callback`, { code: back.searchParams.get("code"), state: back.searchParams.get("state") });
  return ok("POST", `/integrations/oauth/pending/${pending.pendingId}/complete`, { choiceId: provider === "meta" ? "900000000000001" : "1234567890" });
}
async function connectWhatsApp() {
  return ok("PUT", "/integrations/whatsapp", { phoneNumberId: "777777777777", businessAccountId: "888888888888", accessToken: "wa-private-token" });
}
const mapping = () => ({ ...DEFAULT_FEEDBACK_MAPPING, consultation_booked: { ...DEFAULT_FEEDBACK_MAPPING.consultation_booked, enabled: true, conversionActionId: "333" } });
const review = (destination: string) => ok("POST", `/feedback/${destination}/checklist`, { privacyApproved: true, policyChecked: true, dataUnderstood: true });
async function setupWhatsApp() {
  await connectWhatsApp();
  await ok("POST", "/feedback/meta/credentials/from-whatsapp", { testEventCode: "TEST" });
  await ok("PUT", "/feedback/meta/settings", { mapping: mapping(), includeWhatsAppAds: true });
  await review("meta");
}
async function incoming(phone: string, referral?: Record<string, string>, messageId = `${TAG}-${++sequence}`) {
  const response = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: { entry: [{ changes: [{ field: "messages", value: {
    metadata: { phone_number_id: "777777777777" }, contacts: [{ wa_id: phone, profile: { name: `Sync ${TAG} ${letters(sequence)}` } }],
    messages: [{ from: phone, id: messageId, type: "text", text: { body: "Hello" }, ...(referral ? { referral } : {}) }],
  } }] }] } });
  expect(response.statusCode).toBe(200);
  await processDueInboundEvents();
  return messageId;
}
async function personLead(phone: string) {
  const person = (await getOwnerDb().db.select().from(people).where(eq(people.phoneE164, `+${phone}`)))[0]!;
  const lead = (await getOwnerDb().db.select().from(leads).where(eq(leads.personId, person.id)))[0]!;
  return { person, lead };
}

describe("customer channel setup", () => {
  it("discovers connected assets without exposing any access or refresh tokens", async () => {
    await connect("meta"); await connect("google"); await connectWhatsApp();
    const response = await call("GET", "/feedback/assets");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ metaConnected: true, whatsappConnected: true, googleConnected: true, errors: [] });
    expect(response.json().metaDatasets).toHaveLength(1);
    expect(response.json().googleActions).toHaveLength(2);
    expect(response.body).not.toMatch(/mock-long-lived|mock-page-token|mock-google-refresh|wa-private-token/);
  });
  it("uses Facebook and WhatsApp credentials separately and requires tests for both paths", async () => {
    await connect("meta"); await connectWhatsApp();
    await ok("POST", "/feedback/meta/credentials/from-connection", { datasetId: "900000000000003", testEventCode: "META_TEST" });
    await ok("POST", "/feedback/meta/credentials/from-whatsapp", { testEventCode: "WA_TEST" });
    await ok("PUT", "/feedback/meta/settings", { mapping: mapping(), includeWhatsAppAds: true });
    await review("meta");
    expect((await ok("POST", "/feedback/meta/test", { channel: "meta" })).ok).toBe(true);
    expect((await call("POST", "/feedback/meta/go-live", { confirm: true })).statusCode).toBe(400);
    expect((await ok("POST", "/feedback/meta/test", { channel: "whatsapp" })).ok).toBe(true);
    expect((await ok("POST", "/feedback/meta/go-live", { confirm: true })).eligibility).toBe("approved_production");
    expect(meta.sent.map((s) => s.datasetId)).toEqual(["900000000000003", "900000000000008"]);
    expect(meta.sent.map((s) => (s.payload as { test_event_code?: string }).test_event_code)).toEqual(["META_TEST", "WA_TEST"]);
  });
  it("rejects arbitrary Meta datasets and blocks non-admin setup", async () => {
    await connect("meta");
    expect((await call("POST", "/feedback/meta/credentials/from-connection", { datasetId: "123456789012" })).statusCode).toBe(400);
    const fd = await authenticate(app, SEED.frontDesk);
    expect((await call("GET", "/feedback/assets", undefined, fd)).statusCode).toBe(403);
  });
  it("keeps the Google delivery key and connection ID stable across reconnects", async () => {
    const first = await connect("google");
    const before = (await getOwnerDb().db.select().from(integrationConnections).where(eq(integrationConnections.id, first.connection.id)))[0]!;
    const key = JSON.parse(decryptForClinic(clinicId, before.encryptedSecret!)).key;
    const second = await connect("google");
    expect(second.connection.id).toBe(first.connection.id);
    const after = (await getOwnerDb().db.select().from(integrationConnections).where(eq(integrationConnections.id, first.connection.id)))[0]!;
    expect(JSON.parse(decryptForClinic(clinicId, after.encryptedSecret!)).key).toBe(key);
    expect((await app.inject({ method: "POST", url: "/webhooks/google/lead-form", payload: { lead_id: `${TAG}-key`, google_key: key, is_test: true } })).statusCode).toBe(200);
  });
  it("discovers new Google forms automatically and keeps existing webhooks", async () => {
    await connect("google"); google.webhooks.delete("222");
    await getOwnerDb().db.update(integrationConnections).set({ lastCheckedAt: new Date(Date.now() - 2 * 60 * 60_000) }).where(scope());
    expect(await syncDueGoogleForms()).toBe(1);
    expect(google.webhooks.has("222")).toBe(true);
    expect(await syncDueGoogleForms()).toBe(0);
  });
});

describe("WhatsApp ads into CRM and back to Meta", () => {
  it("stores a returning contact's new click on the existing lead and sends the newest matching click", async () => {
    await setupWhatsApp(); await connect("meta");
    const phone = `1305555${String(7100 + ++sequence)}`;
    await incoming(phone);
    const { person, lead } = await personLead(phone);
    const messageId = await incoming(phone, { source_type: "ad", source_id: "123456789", ctwa_clid: "new-ad-click" });
    await incoming(phone, { source_type: "ad", source_id: "123456789", ctwa_clid: "new-ad-click" }, messageId);
    expect(await getOwnerDb().db.select().from(leads).where(eq(leads.personId, person.id))).toHaveLength(1);
    expect((await getOwnerDb().db.select().from(leads).where(eq(leads.id, lead.id)))[0]!.source).toBe("whatsapp_organic");
    const touches = await getOwnerDb().db.select().from(sourceSubmissions).where(eq(sourceSubmissions.leadId, lead.id));
    expect(touches).toHaveLength(2);
    expect(touches.find((s) => s.source === "whatsapp_ad")).toMatchObject({ referralId: "new-ad-click", campaignId: "900000000000006", campaignName: "Demo consultation campaign", normalizedFields: { businessAccountId: "888888888888" } });
    await ok("POST", `/leads/${lead.id}/stage`, { stageId });
    await processFeedbackOutbox();
    const payload = meta.sent[0]!.payload as { data: { user_data: Record<string, string>; action_source: string }[] };
    expect(payload.data[0]).toMatchObject({ action_source: "business_messaging", user_data: { ctwa_clid: "new-ad-click", whatsapp_business_account_id: "888888888888" } });
    expect((await getOwnerDb().db.select().from(feedbackEvents).where(eq(feedbackEvents.leadId, lead.id)))[0]!.state).toBe("accepted");
  });
  it("does not label a post referral as a paid WhatsApp ad", async () => {
    await setupWhatsApp();
    const phone = `1305555${String(7100 + ++sequence)}`;
    await incoming(phone, { source_type: "post", source_id: "123456789" });
    const { lead } = await personLead(phone);
    expect(lead.source).toBe("whatsapp_organic");
    await ok("POST", `/leads/${lead.id}/stage`, { stageId });
    await processFeedbackOutbox();
    expect(meta.sent).toHaveLength(0);
    expect((await getOwnerDb().db.select().from(feedbackEvents).where(eq(feedbackEvents.leadId, lead.id)))[0]!.state).toBe("unmatched");
  });
  it("shows WhatsApp ads in campaign reports, even when they touched an existing lead", async () => {
    await setupWhatsApp(); await connect("meta");
    const phone = `1305555${String(7100 + ++sequence)}`;
    await incoming(phone);
    await incoming(phone, { source_type: "ad", source_id: "123456789", ctwa_clid: "report-click" });
    const date = new Date().toISOString().slice(0, 10);
    const report = await ok("GET", `/reports/summary?from=${date}&to=${date}`);
    expect(report.campaigns.some((c: { platform: string; campaign: string }) => c.platform === "whatsapp" && c.campaign === "Demo consultation campaign")).toBe(true);
  });
});

describe("Google outcomes and asynchronous processing", () => {
  it("uploads each outcome once and tracks Google's final result without resending", async () => {
    await connect("google");
    await ok("POST", "/feedback/google/credentials/from-connection");
    await ok("PUT", "/feedback/google/settings", { mapping: mapping() });
    await review("google");
    const connection = (await getOwnerDb().db.select().from(integrationConnections).where(scope()))[0]!;
    const key = JSON.parse(decryptForClinic(clinicId, connection.encryptedSecret!)).key;
    const email = `${TAG}-${++sequence}@example.test`;
    expect((await app.inject({ method: "POST", url: "/webhooks/google/lead-form", payload: {
      lead_id: `${TAG}-google-${sequence}`, google_key: key, gcl_id: "actual-google-click", campaign_id: "123",
      user_column_data: [{ column_id: "FULL_NAME", string_value: `Sync ${TAG}` }, { column_id: "EMAIL", string_value: email }],
    } })).statusCode).toBe(200);
    await processDueInboundEvents();
    const person = (await getOwnerDb().db.select().from(people).where(eq(people.emailNormalized, email)))[0]!;
    const lead = (await getOwnerDb().db.select().from(leads).where(eq(leads.personId, person.id)))[0]!;
    let uploads = 0;
    let status = "PROCESSING";
    const client = new LiveGoogleFeedbackConnector(async (url, init) => {
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (url.includes("oauth2")) return json({ access_token: "token" });
      if (url.includes("events:ingest")) {
        const body = JSON.parse(String(init?.body));
        expect(body.events[0].adIdentifiers.gclid).toBe("actual-google-click");
        if (body.validateOnly) return json({});
        uploads++;
        return json({ requestId: "google-request" });
      }
      return json({ requestStatusPerDestination: [{ requestStatus: status }] });
    });
    setFeedbackConnectors({ meta, google: client });
    expect((await ok("POST", "/feedback/google/test")).ok).toBe(true);
    await ok("POST", "/feedback/google/go-live", { confirm: true });
    await ok("POST", `/leads/${lead.id}/stage`, { stageId });
    await processFeedbackOutbox();
    const event = () => getOwnerDb().db.select().from(feedbackEvents).where(eq(feedbackEvents.leadId, lead.id));
    expect((await event())[0]!.state).toBe("sent");
    await processFeedbackOutbox(25, new Date(Date.now() + 31 * 60_000));
    expect((await event())[0]!.state).toBe("sent");
    status = "SUCCESS";
    await processFeedbackOutbox(25, new Date(Date.now() + 2 * 60 * 60_000));
    expect((await event())[0]!.state).toBe("accepted");
    expect(uploads).toBe(1);
  });
});

describe("sync safety and recovery", () => {
  it("invalidates validation and waiting conversions when settings change", async () => {
    await setupWhatsApp();
    expect((await ok("POST", "/feedback/meta/test", { channel: "whatsapp" })).ok).toBe(true);
    await ok("POST", "/feedback/meta/go-live", { confirm: true });
    const phone = `1305555${String(7100 + ++sequence)}`;
    await incoming(phone, { source_type: "ad", source_id: "123456789", ctwa_clid: "queued-click" });
    const { lead } = await personLead(phone);
    await ok("POST", `/leads/${lead.id}/stage`, { stageId });
    await ok("PUT", "/feedback/meta/settings", { mapping: mapping(), includeWhatsAppAds: false });
    await processFeedbackOutbox();
    expect((await getOwnerDb().db.select().from(feedbackEvents).where(eq(feedbackEvents.leadId, lead.id)))[0]!.state).toBe("canceled");
    expect((await call("POST", "/feedback/meta/go-live", { confirm: true })).statusCode).toBe(400);
  });
  it("disconnecting a channel revokes conversion sending linked to it", async () => {
    await setupWhatsApp();
    const connection = (await getOwnerDb().db.select().from(integrationConnections).where(scope()))[0]!;
    expect((await call("DELETE", `/integrations/${connection.id}`)).statusCode).toBe(204);
    const dest = (await getOwnerDb().db.select().from(feedbackDestinations).where(eq(feedbackDestinations.clinicId, clinicId)))[0]!;
    expect(dest.eligibility).toBe("unreviewed"); expect(dest.encryptedSecret).toBeNull();
  });
  it("retries failed inbound events without duplicating a message or lead", async () => {
    await connectWhatsApp();
    const phone = `1305555${String(7100 + ++sequence)}`;
    const messageId = await incoming(phone);
    const { person } = await personLead(phone);
    const event = (await getOwnerDb().db.select().from(inboundEvents).where(eq(inboundEvents.externalId, messageId)))[0]!;
    await getOwnerDb().db.update(inboundEvents).set({ state: "failed", attempts: 6 }).where(eq(inboundEvents.id, event.id));
    await ok("POST", `/integrations/events/${event.id}/retry`);
    await processDueInboundEvents();
    expect(await getOwnerDb().db.select().from(leads).where(eq(leads.personId, person.id))).toHaveLength(1);
    expect((await call("POST", `/integrations/events/${event.id}/retry`)).statusCode).toBe(400);
  });
  it("keeps failed WhatsApp events linked when reconnecting the same number", async () => {
    const first = await connectWhatsApp();
    const start = await ok("POST", "/integrations/whatsapp/signup/start");
    const next = await ok("POST", "/integrations/whatsapp/signup/complete", {
      state: start.state, code: "mock-wa-code", phoneNumberId: "777777777777", wabaId: "888888888888", coexistence: true,
    });
    expect(next.connection.id).toBe(first.id);
    expect(await getOwnerDb().db.select().from(integrationConnections).where(scope())).toHaveLength(1);
  });
  it("does not let another clinic retry or check this clinic's connection", async () => {
    const connection = await connectWhatsApp();
    const other = await authenticate(app, SEED.otherClinicAdmin);
    expect((await call("POST", `/integrations/${connection.id}/check`, undefined, other)).statusCode).toBe(404);
    expect((await call("POST", "/feedback/meta/credentials/from-whatsapp", {}, other)).statusCode).toBe(400);
  });
  it("rejects conversion actions outside the connected Google account", async () => {
    await connect("google"); await ok("POST", "/feedback/google/credentials/from-connection");
    const bad = mapping(); bad.consultation_booked.conversionActionId = "999999";
    expect((await call("PUT", "/feedback/google/settings", { mapping: bad })).statusCode).toBe(400);
    const valid = await ok("PUT", "/feedback/google/settings", { mapping: mapping() });
    expect(valid.mapping.consultation_booked.conversionCustomerId).toBe("1234567890");
  });
});
