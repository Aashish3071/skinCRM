/** "Connect with Facebook" and "Connect with Google Ads" on the demo clients (D-87). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockGoogleOAuthClient, MockMetaOAuthClient, setOAuthClients } from "@skincrm/connectors";
import { decryptForClinic } from "@skincrm/security";
import { SEED, authenticate, clinicIdBySlug, createTestApp, resetAuthState } from "./helpers";

const { integrationConnections } = schema;
let app: FastifyInstance;
let admin: string;
let clinicId: string;
let google: MockGoogleOAuthClient;
/** Connections that existed before, restored afterwards (the dev database is shared). */
let saved: (typeof integrationConnections.$inferSelect)[] = [];

beforeAll(async () => {
  google = new MockGoogleOAuthClient();
  setOAuthClients({ meta: new MockMetaOAuthClient(), google });
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  saved = await getOwnerDb().db.select().from(integrationConnections)
    .where(and(eq(integrationConnections.clinicId, clinicId), eq(integrationConnections.provider, "google_lead_forms")));
});
afterAll(async () => {
  const { db } = getOwnerDb();
  await db.delete(integrationConnections).where(and(eq(integrationConnections.clinicId, clinicId), eq(integrationConnections.provider, "google_lead_forms")));
  await db.delete(integrationConnections).where(eq(integrationConnections.externalAccountId, "900000000000001"));
  if (saved.length) await db.insert(integrationConnections).values(saved);
  setOAuthClients(undefined);
  await app.close();
  await closeAllConnections();
});

const call = (method: "GET" | "POST", url: string, payload?: unknown, cookie = admin) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

/** Start → the demo client sends the browser straight back with a code. */
async function signIn(provider: "meta" | "google") {
  const start = await call("POST", `/integrations/oauth/${provider}/start`);
  expect(start.statusCode).toBe(200);
  const back = new URL(start.json().url, "http://web.test");
  expect(back.pathname).toBe(`/settings/integrations/oauth/${provider}/callback`);
  return { code: back.searchParams.get("code")!, state: back.searchParams.get("state")! };
}

describe("Connect with Facebook", () => {
  it("lists the person's Pages, connects the chosen one, and burns every one-time id", async () => {
    const { code, state } = await signIn("meta");
    const callback = await call("POST", "/integrations/oauth/meta/callback", { code, state });
    expect(callback.statusCode).toBe(200);
    const pendingId = callback.json().pendingId as string;

    // The state works once.
    expect((await call("POST", "/integrations/oauth/meta/callback", { code, state })).statusCode).toBe(400);

    const pending = await call("GET", `/integrations/oauth/pending/${pendingId}`);
    expect(pending.json().choices.map((c: { label: string }) => c.label)).toEqual(["Demo Skin Clinic", "Demo Skin Clinic — Tampa"]);
    // No token ever reaches the browser.
    expect(pending.body).not.toContain("mock-page-token");

    const done = await call("POST", `/integrations/oauth/pending/${pendingId}/complete`, { choiceId: "900000000000001" });
    expect(done.statusCode).toBe(200);
    expect(done.json().connection).toMatchObject({ provider: "meta_lead_ads", connectedVia: "oauth", accountLabel: "900000000000001", displayName: "Demo Skin Clinic" });
    expect((await call("POST", `/integrations/oauth/pending/${pendingId}/complete`, { choiceId: "900000000000001" })).statusCode).toBe(404);

    const [row] = await getOwnerDb().db.select().from(integrationConnections).where(eq(integrationConnections.externalAccountId, "900000000000001"));
    expect(decryptForClinic(row!.clinicId, row!.encryptedSecret!)).toBe("mock-page-token-1");
  });

  it("refuses a forged state and a provider mismatch", async () => {
    expect((await call("POST", "/integrations/oauth/meta/callback", { code: "mock-meta-code", state: "x".repeat(43) })).statusCode).toBe(400);
    const { code, state } = await signIn("meta");
    expect((await call("POST", "/integrations/oauth/google/callback", { code, state })).statusCode).toBe(400);
  });

  it("is admin-only", async () => {
    const frontDesk = await authenticate(app, SEED.frontDesk);
    expect((await call("POST", "/integrations/oauth/meta/start", undefined, frontDesk)).statusCode).toBe(403);
  });
});

describe("Connect with Google Ads", () => {
  it("connects the ad account, puts our webhook on every lead form, and leads arrive with the key", async () => {
    const { code, state } = await signIn("google");
    const pendingId = (await call("POST", "/integrations/oauth/google/callback", { code, state })).json().pendingId as string;
    const pending = await call("GET", `/integrations/oauth/pending/${pendingId}`);
    expect(pending.json().choices[0]).toMatchObject({ id: "1234567890", label: "Demo Skin Clinic Ads", detail: "123-456-7890" });

    const done = await call("POST", `/integrations/oauth/pending/${pendingId}/complete`, { choiceId: "1234567890" });
    expect(done.statusCode).toBe(200);
    expect(done.json().connection).toMatchObject({ provider: "google_lead_forms", connectedVia: "oauth", leadForms: 2, accountLabel: "123-456-7890" });
    expect(done.json().detail).toContain("2 lead forms now send leads");
    expect([...google.webhooks.values()].every((url) => url.endsWith("/webhooks/google/lead-form"))).toBe(true);

    // Google will post leads with the key we gave it.
    const [row] = await getOwnerDb().db.select().from(integrationConnections)
      .where(and(eq(integrationConnections.clinicId, clinicId), eq(integrationConnections.provider, "google_lead_forms")));
    const { key } = JSON.parse(decryptForClinic(clinicId, row!.encryptedSecret!)) as { key: string };
    const leadId = `oauth-${Date.now()}`;
    const lead = await app.inject({ method: "POST", url: "/webhooks/google/lead-form", payload: { lead_id: leadId, google_key: key, is_test: true, user_column_data: [] } });
    expect(lead.statusCode).toBe(200);
    // Queued for the worker; remove it so other suites' queue counts stay exact.
    await getOwnerDb().db.delete(schema.inboundEvents).where(eq(schema.inboundEvents.externalId, leadId));

    const sync = await call("POST", "/integrations/google/sync-forms");
    expect(sync.statusCode).toBe(200);
    expect(sync.json().detail).toContain("All 2 lead forms already send leads");
  });

  it("lets conversion feedback reuse the connected account, without the token ever reaching the browser", async () => {
    const { feedbackDestinations } = schema;
    const { db } = getOwnerDb();
    const where = and(eq(feedbackDestinations.clinicId, clinicId), eq(feedbackDestinations.destination, "google"));
    const [before] = await db.select().from(feedbackDestinations).where(where);
    try {
      const overview = await call("GET", "/feedback");
      expect(overview.json().connectedGoogleAds).toEqual({ customerId: "1234567890", name: "Demo Skin Clinic Ads" });
      expect(overview.body).not.toContain("mock-google-refresh-token");

      const applied = await call("POST", "/feedback/google/credentials/from-connection");
      expect(applied.statusCode).toBe(200);
      const [after] = await db.select().from(feedbackDestinations).where(where);
      const creds = JSON.parse(decryptForClinic(clinicId, after!.encryptedSecret!)) as { refreshToken: string };
      expect(creds.refreshToken).toBe("mock-google-refresh-token");
      expect(after!.config).toMatchObject({ customerId: "1234567890" });
    } finally {
      if (before) await db.update(feedbackDestinations).set(before).where(where);
    }
  });
});

describe("live clients (fake network)", async () => {
  const { LiveMetaOAuthClient, LiveGoogleOAuthClient } = await import("@skincrm/connectors");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("Meta: asks for lead permissions, returns a long-lived token, keeps only Pages with a token", async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.includes("oauth/access_token") && url.includes("code=")) return json({ access_token: "short" });
      if (url.includes("fb_exchange_token=short")) return json({ access_token: "long" });
      if (url.includes("me/accounts")) return json({ data: [
        { id: "1", name: "Clinic", access_token: "p1", tasks: ["ADVERTISE", "ANALYZE"] },
        { id: "2", name: "No token" },
        { id: "3", name: "Viewer", access_token: "p3", tasks: ["ANALYZE"] },
      ] });
      return json({ success: true });
    };
    const client = new LiveMetaOAuthClient({ appId: "app", appSecret: "secret" }, fake);
    const url = new URL(client.authorizeUrl({ state: "s", redirectUri: "https://crm.test/cb" }));
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("scope")).toContain("leads_retrieval");
    expect(new URL(new LiveMetaOAuthClient({ appId: "a", appSecret: "b", loginConfigId: "cfg" }, fake).authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).searchParams.get("config_id")).toBe("cfg");
    expect(await client.exchangeCode({ code: "c", redirectUri: "https://crm.test/cb" })).toBe("long");
    const pages = await client.listPages("long");
    expect(pages.map((p) => [p.id, p.canReadLeads])).toEqual([["1", true], ["3", false]]);
    await client.subscribePage("1", "p1");
    expect(calls.at(-1)).toContain("1/subscribed_apps?subscribed_fields=leadgen");
  });

  it("Google: asks for offline Ads access, sets our webhook, and never overwrites another system's", async () => {
    const bodies: unknown[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return String(init?.body).includes("authorization_code") ? json({ refresh_token: "r", access_token: "a" }) : json({ access_token: "a" });
      }
      bodies.push(JSON.parse(String(init?.body)));
      expect((init?.headers as Record<string, string>)["developer-token"]).toBe("dev");
      return json({});
    };
    const client = new LiveGoogleOAuthClient({ clientId: "id", clientSecret: "s", developerToken: "dev" }, fake);
    const url = new URL(client.authorizeUrl({ state: "s", redirectUri: "https://crm.test/cb" }));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/adwords");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/datamanager");
    expect(await client.exchangeCode({ code: "c", redirectUri: "https://crm.test/cb" })).toBe("r");
    const account = { customerId: "1", name: "A", loginCustomerId: null };
    const hook = { url: "https://crm.test/webhooks/google/lead-form", key: "k" };
    await client.addWebhook("r", account, { resourceName: "customers/1/assets/9", id: "9", name: "F", webhookUrls: [] }, hook);
    const methods = (bodies[0] as { operations: { update: { leadFormAsset: { deliveryMethods: { webhook: { advertiserWebhookUrl: string; googleSecret?: string } }[] } } }[] })
      .operations[0]!.update.leadFormAsset.deliveryMethods;
    expect(methods).toEqual([{ webhook: { advertiserWebhookUrl: hook.url, googleSecret: "k", payloadSchemaVersion: 3 } }]);
    await expect(client.addWebhook("r", account, { resourceName: "customers/1/assets/8", id: "8", name: "G", webhookUrls: ["https://other-crm.test/hook"] }, hook))
      .rejects.toThrow(/another system/);
    expect(bodies).toHaveLength(1);
  });
});
