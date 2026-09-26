/**
 * Ad-platform lead ingestion, WhatsApp webhooks, live connectors and outbound
 * settings (PRD INT-01…05, WA-05, MSG-01).
 */
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import {
  ConnectorError,
  MockEmailConnector,
  MockWhatsAppConnector,
  WhatsAppCloudConnector,
  LiveMetaLeadsConnector,
  resetConnectors,
  setConnectors,
} from "@skincrm/connectors";
import { resetEnvCache } from "@skincrm/config";
import { SEED, authenticate, clinicIdBySlug, createTestApp, resetAuthState } from "./helpers";
import { processDueInboundEvents } from "../integrations/processor";

const { people, leads, leadStageEvents, activities, messages, conversations, consentRecords, sourceSubmissions, integrationConnections, inboundEvents, clinics, rawPayloads } = schema;

/** Account ids these tests use; cleanup touches nothing else (the dev database is shared). */
const TEST_ACCOUNT_IDS = ["123456789", "11112222", "555"];
const createdGoogle: string[] = [];

let app: FastifyInstance;
let admin: string;
let email: MockEmailConnector;

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
});
afterAll(async () => {
  await cleanup();
  resetConnectors();
  await app.close();
  await closeAllConnections();
});
beforeEach(async () => {
  await cleanup();
  email = new MockEmailConnector();
  setConnectors({ email, whatsapp: new MockWhatsAppConnector() });
});
afterEach(() => {
  delete process.env.OUTBOUND_SENDING_ENABLED;
  delete process.env.META_APP_SECRET;
  resetEnvCache();
});

async function cleanup() {
  const { db } = getOwnerDb();
  // Only what these tests create: the test page and number ids, and Google
  // keys connected by the seeded admin during a test run.
  const testConnections = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(or(inArray(integrationConnections.externalAccountId, TEST_ACCOUNT_IDS), inArray(integrationConnections.id, createdGoogle)));
  const connIds = testConnections.map((c) => c.id);
  if (connIds.length) {
    await db.delete(inboundEvents).where(inArray(inboundEvents.connectionId, connIds));
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, connIds));
  }
  createdGoogle.length = 0;
  const ids = (await db.select({ id: people.id }).from(people).where(or(like(people.displayName, "%Test Lead%"), like(people.phoneRaw, "+1305559%")))).map((r) => r.id);
  if (!ids.length) return;
  await db.delete(messages).where(inArray(messages.personId, ids));
  await db.delete(conversations).where(inArray(conversations.personId, ids));
  await db.delete(consentRecords).where(inArray(consentRecords.personId, ids));
  const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
  if (leadIds.length) {
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }
  await db.delete(activities).where(inArray(activities.personId, ids));
  const subs = await db.select({ raw: sourceSubmissions.rawPayloadId }).from(sourceSubmissions).where(inArray(sourceSubmissions.personId, ids));
  await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.personId, ids));
  const rawIds = subs.map((s) => s.raw).filter((x): x is string => Boolean(x));
  if (rawIds.length) await db.delete(rawPayloads).where(inArray(rawPayloads.id, rawIds));
  await db.delete(people).where(inArray(people.id, ids));
}

async function connectMeta(pageId = "123456789") {
  const res = await app.inject({ method: "PUT", url: "/integrations/meta", headers: { cookie: admin }, payload: { pageId, accessToken: "page-token-secret" } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const leadgenBody = (leadgenId: string, pageId = "123456789") => ({
  object: "page",
  entry: [{ id: pageId, changes: [{ field: "leadgen", value: { leadgen_id: leadgenId, page_id: pageId, form_id: "f1", ad_id: "a1" } }] }],
});

describe("Meta Lead Ads", () => {
  it("answers the subscription handshake only with the right token", async () => {
    const ok = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=dev_meta_verify_token&hub.challenge=42" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("42");
    const bad = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" });
    expect(bad.statusCode).toBe(403);
  });

  it("never returns the stored token", async () => {
    const connection = await connectMeta();
    expect(JSON.stringify(connection)).not.toContain("page-token-secret");
    const overview = await app.inject({ method: "GET", url: "/integrations", headers: { cookie: admin } });
    expect(overview.body).not.toContain("page-token-secret");
  });

  it("turns a leadgen webhook into a lead with attribution, once", async () => {
    await connectMeta();
    const first = await app.inject({ method: "POST", url: "/webhooks/meta", payload: leadgenBody("9990001") });
    expect(first.statusCode).toBe(200);
    // Meta redelivers; the second copy must not create anything.
    await app.inject({ method: "POST", url: "/webhooks/meta", payload: leadgenBody("9990001") });
    expect(await processDueInboundEvents()).toBe(1);

    const { db } = getOwnerDb();
    const sub = (await db.select().from(sourceSubmissions).where(eq(sourceSubmissions.externalId, "9990001")))[0]!;
    expect(sub.source).toBe("meta_lead_ad");
    expect(sub.adId).toBe("mock-ad-1");
    const lead = (await db.select().from(leads).where(eq(leads.id, sub.leadId!)))[0]!;
    expect(lead.source).toBe("meta_lead_ad");
    const person = (await db.select().from(people).where(eq(people.id, lead.personId)))[0]!;
    expect(person.displayName).toContain("Meta Test Lead");
  });

  it("checks Meta's signature when an app secret is set", async () => {
    await connectMeta();
    process.env.META_APP_SECRET = "shh";
    resetEnvCache();
    const payload = JSON.stringify(leadgenBody("9990002"));
    const unsigned = await app.inject({ method: "POST", url: "/webhooks/meta", payload, headers: { "content-type": "application/json" } });
    expect(unsigned.statusCode).toBe(401);
    const sig = `sha256=${createHmac("sha256", "shh").update(payload).digest("hex")}`;
    const signed = await app.inject({ method: "POST", url: "/webhooks/meta", payload, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
    expect(signed.statusCode).toBe(200);
  });

  it("ignores pages no clinic has connected", async () => {
    const res = await app.inject({ method: "POST", url: "/webhooks/meta", payload: leadgenBody("9990003", "555") });
    expect(res.statusCode).toBe(200);
    expect(await getOwnerDb().db.select().from(inboundEvents).where(eq(inboundEvents.externalId, "9990003"))).toHaveLength(0);
  });

  it("sends a test lead end to end from Settings", async () => {
    await connectMeta();
    const res = await app.inject({ method: "POST", url: "/integrations/meta/test-lead", headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    await processDueInboundEvents();
    const events = await getOwnerDb().db.select().from(inboundEvents).where(eq(inboundEvents.type, "meta_leadgen"));
    expect(events[0]!.state).toBe("processed");
    expect(events[0]!.result).toMatch(/^lead:/);
  });

  it("retries a failing fetch and records the error", async () => {
    await connectMeta();
    const { setMetaLeadsConnector } = await import("@skincrm/connectors");
    setMetaLeadsConnector({
      mode: "mock",
      fetchLead: async () => { throw new ConnectorError("Meta is down", { retryable: true }); },
      verifyPage: async () => ({ ok: true, name: "x", detail: "" }),
    });
    await app.inject({ method: "POST", url: "/webhooks/meta", payload: leadgenBody("9990004") });
    await processDueInboundEvents();
    setMetaLeadsConnector(undefined);
    const event = (await getOwnerDb().db.select().from(inboundEvents).where(eq(inboundEvents.externalId, "9990004")))[0]!;
    expect(event.state).toBe("pending");
    expect(event.attempts).toBe(1);
    expect(event.lastError).toBe("Meta is down");
  });
});

describe("Google Ads lead forms", () => {
  it("accepts a lead with the clinic's key and rejects an unknown key", async () => {
    const created = await app.inject({ method: "POST", url: "/integrations/google/key", headers: { cookie: admin } });
    const key = created.json().key as string;
    createdGoogle.push(created.json().id as string);
    expect(key.length).toBeGreaterThan(20);

    const bad = await app.inject({ method: "POST", url: "/webhooks/google/lead-form", payload: { lead_id: "g1", google_key: "wrong" } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST",
      url: "/webhooks/google/lead-form",
      payload: {
        lead_id: "g-100", google_key: key, campaign_id: 77, gcl_id: "gclid-abc", form_id: 5,
        user_column_data: [
          { column_id: "FULL_NAME", string_value: "Google Test Lead Rosa" },
          { column_id: "PHONE_NUMBER", string_value: "+13055590001" },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    await processDueInboundEvents();
    const sub = (await getOwnerDb().db.select().from(sourceSubmissions).where(eq(sourceSubmissions.externalId, "g-100")))[0]!;
    expect(sub.source).toBe("google_lead_form");
    expect(sub.clickId).toBe("gclid-abc");
    expect(sub.campaignId).toBe("77");
  });
});

describe("WhatsApp Cloud webhooks and connector", () => {
  async function connectWhatsApp() {
    const res = await app.inject({ method: "PUT", url: "/integrations/whatsapp", headers: { cookie: admin },
      payload: { phoneNumberId: "11112222", accessToken: "wa-token", displayPhone: "+1 305 555 0000" } });
    expect(res.statusCode).toBe(200);
  }

  it("turns an inbound message into a thread and a lead", async () => {
    await connectWhatsApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { entry: [{ changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "11112222" },
        contacts: [{ wa_id: "13055590002", profile: { name: "Test Lead Wa" } }],
        messages: [{ from: "13055590002", id: "wamid.1", timestamp: "1790000000", type: "text", text: { body: "Hi there" } }],
      } }] }] },
    });
    expect(res.statusCode).toBe(200);
    await processDueInboundEvents();
    const person = (await getOwnerDb().db.select().from(people).where(eq(people.phoneE164, "+13055590002")))[0]!;
    expect(await getOwnerDb().db.select().from(leads).where(eq(leads.personId, person.id))).toHaveLength(1);
    expect(await getOwnerDb().db.select().from(conversations).where(eq(conversations.personId, person.id))).toHaveLength(1);
  });

  it("records delivered and read, never going backwards", async () => {
    await connectWhatsApp();
    const clinicId = await clinicIdBySlug(SEED.clinicA);
    const { db } = getOwnerDb();
    const person = (await db.insert(people).values({ clinicId, displayName: "Test Lead Status", phoneRaw: "+13055590003", phoneE164: "+13055590003" }).returning())[0]!;
    await db.insert(messages).values({ clinicId, personId: person.id, channel: "whatsapp", classification: "operational", state: "sent", providerMessageId: "wamid.out", idempotencyKey: "t-status" });
    const status = (s: string) => app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: { entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "11112222" }, statuses: [{ id: "wamid.out", status: s, timestamp: "1790000100" }] } }] }] } });
    await status("read");
    await status("delivered");
    await processDueInboundEvents();
    const row = (await db.select().from(messages).where(eq(messages.providerMessageId, "wamid.out")))[0]!;
    expect(row.state).toBe("read");
  });

  it("the live connector sends text through the Graph API with a bearer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.live" }] }), { status: 200 });
    };
    const c = new WhatsAppCloudConnector({ phoneNumberId: "999", accessToken: "tok" }, fake);
    const r = await c.send({ kind: "text", toWaId: "13055550000", body: "Hello", idempotencyKey: "k" });
    expect(r.providerMessageId).toBe("wamid.live");
    expect(calls[0]!.url).toContain("/999/messages");
    expect(calls[0]!.url).not.toContain("tok");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init!.body)).text.body).toBe("Hello");
  });

  it("the live connector maps Meta errors to retry and suppression decisions", async () => {
    const failing = (code: number, status = 400) => async () =>
      new Response(JSON.stringify({ error: { message: "nope", code } }), { status });
    const notOnWhatsApp = new WhatsAppCloudConnector({ phoneNumberId: "1", accessToken: "t" }, failing(131026));
    await expect(notOnWhatsApp.send({ kind: "text", toWaId: "1", body: "x", idempotencyKey: "k" })).rejects.toMatchObject({
      options: { retryable: false, permanentSuppression: true },
    });
    const rateLimited = new WhatsAppCloudConnector({ phoneNumberId: "1", accessToken: "t" }, failing(130429, 429));
    await expect(rateLimited.send({ kind: "text", toWaId: "1", body: "x", idempotencyKey: "k" })).rejects.toMatchObject({
      options: { retryable: true },
    });
  });

  it("the live Meta leads connector reads field_data", async () => {
    const fake = async () => new Response(JSON.stringify({ id: "1", field_data: [{ name: "full_name", values: ["Ana B"] }], ad_id: "ad9" }), { status: 200 });
    const lead = await new LiveMetaLeadsConnector(fake).fetchLead("1", "tok");
    expect(lead.fields.full_name).toBe("Ana B");
    expect(lead.adId).toBe("ad9");
  });
});

describe("outbound settings", () => {
  it("refuses to approve marketing without a postal address, then approves it", async () => {
    const { db } = getOwnerDb();
    const clinicId = await clinicIdBySlug(SEED.clinicA);
    const before = (await db.select().from(clinics).where(eq(clinics.id, clinicId)))[0]!;
    await db.update(clinics).set({ postalAddress: null }).where(eq(clinics.id, clinicId));
    const refused = await app.inject({ method: "PATCH", url: "/settings/messaging", headers: { cookie: admin }, payload: { promotionalSendingApproved: true } });
    expect(refused.statusCode).toBe(400);
    const ok = await app.inject({ method: "PATCH", url: "/settings/messaging", headers: { cookie: admin }, payload: { promotionalSendingApproved: true, postalAddress: "1 Ocean Dr, Miami FL" } });
    expect(ok.statusCode).toBe(200);
    expect((await db.select().from(clinics).where(eq(clinics.id, clinicId)))[0]!.promotionalSendingApproved).toBe(true);
    await db.update(clinics).set({ postalAddress: before.postalAddress, promotionalSendingApproved: before.promotionalSendingApproved }).where(eq(clinics.id, clinicId));
  });

  it("sends a test email only when sending is switched on", async () => {
    const off = await app.inject({ method: "POST", url: "/integrations/test-send", headers: { cookie: admin }, payload: { channel: "email", to: "me@example.test" } });
    expect(off.statusCode).toBe(400);
    process.env.OUTBOUND_SENDING_ENABLED = "true";
    resetEnvCache();
    const on = await app.inject({ method: "POST", url: "/integrations/test-send", headers: { cookie: admin }, payload: { channel: "email", to: "me@example.test" } });
    expect(on.json().ok).toBe(true);
    expect(email.outbox().some((m) => m.to === "me@example.test")).toBe(true);
  });

  it("is admin-only", async () => {
    const fd = await authenticate(app, SEED.frontDesk);
    expect((await app.inject({ method: "PUT", url: "/integrations/meta", headers: { cookie: fd }, payload: { pageId: "123456", accessToken: "x" } })).statusCode).toBe(403);
  });
});
