/** Ad account management (D-95) on the demo clients: campaigns, spend, audiences, history. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockAdsClient, MockGoogleOAuthClient, MockMetaOAuthClient, setAdsClient, setOAuthClients, type HistoricLead } from "@skincrm/connectors";
import { SEED, authenticate, clinicIdBySlug, createTestApp, letters, resetAuthState } from "./helpers";
import { processDueInboundEvents } from "../integrations/processor";

const { integrationConnections, adSpendDaily, adAudiences, people, consentRecords, leads, inboundEvents } = schema;
const TAG = `ads${letters(Date.now())}`;
let app: FastifyInstance;
let admin: string;
let clinicId: string;
let meta: MockAdsClient;
let google: MockAdsClient;
let saved: (typeof integrationConnections.$inferSelect)[] = [];

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });

async function connect(provider: "meta" | "google", choiceId: string) {
  const start = await call("POST", `/integrations/oauth/${provider}/start`);
  const back = new URL(start.json().url, "http://web.test");
  const pending = await call("POST", `/integrations/oauth/${provider}/callback`, { code: back.searchParams.get("code"), state: back.searchParams.get("state") });
  const done = await call("POST", `/integrations/oauth/pending/${pending.json().pendingId}/complete`, { choiceId });
  expect(done.statusCode).toBe(200);
}

beforeAll(async () => {
  setOAuthClients({ meta: new MockMetaOAuthClient(), google: new MockGoogleOAuthClient() });
  meta = new MockAdsClient("meta");
  google = new MockAdsClient("google");
  setAdsClient("meta", meta);
  setAdsClient("google", google);
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  const { db } = getOwnerDb();
  saved = await db.select().from(integrationConnections).where(and(eq(integrationConnections.clinicId, clinicId), inArray(integrationConnections.provider, ["meta_lead_ads", "google_lead_forms"])));
  await db.delete(integrationConnections).where(and(eq(integrationConnections.clinicId, clinicId), inArray(integrationConnections.provider, ["meta_lead_ads", "google_lead_forms"])));
  await connect("meta", "900000000000001");
  await connect("google", "1234567890");
});

afterAll(async () => {
  const { db } = getOwnerDb();
  await db.delete(adAudiences).where(eq(adAudiences.clinicId, clinicId));
  await db.delete(adSpendDaily).where(eq(adSpendDaily.clinicId, clinicId));
  await db.delete(inboundEvents).where(like(inboundEvents.externalId, `%${TAG}%`));
  const ids = (await db.select({ id: people.id }).from(people).where(like(people.lastName, `%${TAG}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(consentRecords).where(inArray(consentRecords.personId, ids));
    await db.delete(people).where(inArray(people.id, ids));
  }
  await db.delete(integrationConnections).where(and(eq(integrationConnections.clinicId, clinicId), inArray(integrationConnections.provider, ["meta_lead_ads", "google_lead_forms"])));
  if (saved.length) await db.insert(integrationConnections).values(saved);
  setOAuthClients(undefined);
  setAdsClient("meta", undefined);
  setAdsClient("google", undefined);
  await app.close();
  await closeAllConnections();
});

describe("campaigns", () => {
  it("asks which Facebook ad account to use, then lists both platforms' campaigns", async () => {
    let overview = (await call("GET", "/advertising")).json();
    expect(overview.platforms.find((p: { platform: string }) => p.platform === "meta").needsAccount).toBe(true);
    const accounts = (await call("GET", "/advertising/meta/accounts")).json().items;
    expect((await call("PUT", "/advertising/meta/account", { accountId: "act_999999999" })).statusCode).toBe(400);
    expect((await call("PUT", "/advertising/meta/account", { accountId: accounts[0].id })).statusCode).toBe(200);
    overview = (await call("GET", "/advertising")).json();
    const names = overview.platforms.flatMap((p: { campaigns: { name: string }[] }) => p.campaigns.map((c) => c.name));
    expect(names).toEqual(expect.arrayContaining(["Spring skin consult — Leads", "Search — Dermatologist near me"]));
  });

  it("pauses, resumes and changes a daily budget, refusing shared budgets and slipped digits", async () => {
    expect((await call("POST", "/advertising/meta/campaigns/120000000000001/status", { active: false })).statusCode).toBe(200);
    expect(meta.campaigns[0]!.status).toBe("paused");
    await call("POST", "/advertising/meta/campaigns/120000000000001/status", { active: true });
    expect((await call("POST", "/advertising/meta/campaigns/120000000000001/budget", { dailyBudget: 55.5 })).statusCode).toBe(200);
    expect(meta.campaigns[0]!.dailyBudgetMicros).toBe(55_500_000);
    expect((await call("POST", "/advertising/meta/campaigns/120000000000001/budget", { dailyBudget: 50_000 })).statusCode).toBe(400);
    expect((await call("POST", "/advertising/google/campaigns/21000000002/budget", { dailyBudget: 20 })).statusCode).toBe(400);
  });

  it("copies spend so Reports can show cost per lead", async () => {
    expect((await call("POST", "/advertising/meta/sync-spend")).statusCode).toBe(200);
    const rows = await getOwnerDb().db.select().from(adSpendDaily).where(eq(adSpendDaily.clinicId, clinicId));
    expect(rows.length).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const report = (await call("GET", `/reports/summary?from=${from}&to=${today}`)).json();
    const spring = report.campaigns.find((c: { campaignId: string | null }) => c.campaignId === "120000000000001");
    expect(spring.spendMicros).toBeGreaterThan(0);
  });
});

describe("audiences", () => {
  it("uploads only people who agreed to marketing, hashed, and keeps the list in step", async () => {
    const { db } = getOwnerDb();
    const [yes] = await db.insert(people).values({ clinicId, firstName: "Yes", lastName: TAG, displayName: `Yes ${TAG}`, emailRaw: `yes.${TAG}@example.test`, emailNormalized: `yes.${TAG}@example.test`, phoneRaw: "+13055550111", phoneE164: "+13055550111", phoneValid: true }).returning();
    const [no] = await db.insert(people).values({ clinicId, firstName: "No", lastName: TAG, displayName: `No ${TAG}`, emailRaw: `no.${TAG}@example.test`, emailNormalized: `no.${TAG}@example.test` }).returning();
    await db.insert(consentRecords).values([
      { clinicId, personId: yes!.id, channel: "email" as const, purpose: "promotional" as const, status: "granted" as const, source: "verbal_staff_recorded" as const },
      { clinicId, personId: no!.id, channel: "email" as const, purpose: "promotional" as const, status: "granted" as const, source: "verbal_staff_recorded" as const, occurredAt: new Date(Date.now() - 60_000) },
      { clinicId, personId: no!.id, channel: "email" as const, purpose: "promotional" as const, status: "withdrawn" as const, source: "verbal_staff_recorded" as const },
    ]);

    const created = await call("POST", "/advertising/audiences", { platform: "meta", segment: "marketing_consented", name: `All opted-in ${TAG}` });
    expect(created.statusCode).toBe(201);
    const [audience] = [...meta.audiences.values()];
    const { createHash } = await import("node:crypto");
    const hashOf = (v: string) => createHash("sha256").update(v).digest("hex");
    const emails = audience!.members.map((m) => m.emailSha256);
    expect(emails).toContain(hashOf(`yes.${TAG}@example.test`));
    expect(emails).not.toContain(hashOf(`no.${TAG}@example.test`));
    // No marketing consent on WhatsApp/SMS → phone not uploaded.
    expect(audience!.members.find((m) => m.emailSha256 === hashOf(`yes.${TAG}@example.test`))!.phoneSha256).toBeNull();
    expect(JSON.stringify(audience!.members)).not.toContain("@");

    expect((await call("DELETE", `/advertising/audiences/${created.json().id}`)).statusCode).toBe(204);
    expect(meta.audiences.size).toBe(0);
  });
});

describe("lead history", () => {
  it("imports past Facebook leads quietly: original dates, no automations, no response clock; skips ones we have", async () => {
    const old = new Date(Date.now() - 20 * 86_400_000);
    meta.historic.push({ externalId: `9${Date.now()}`.slice(0, 15), submittedAt: old, formId: "form-1", campaignId: null, gclid: null, fields: [] } satisfies HistoricLead);
    const first = await call("POST", "/advertising/meta/import-leads", { days: 30 });
    expect(first.json()).toEqual({ queued: 1, alreadyHad: 0 });
    expect((await call("POST", "/advertising/meta/import-leads", { days: 30 })).json()).toEqual({ queued: 0, alreadyHad: 1 });
    await processDueInboundEvents();
    const { db } = getOwnerDb();
    const [event] = await db.select().from(inboundEvents).where(eq(inboundEvents.externalId, meta.historic[0]!.externalId));
    expect({ state: event!.state, error: event!.lastError }).toMatchObject({ state: "processed" });
    const leadId = event!.result!.replace("lead:", "");
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.slaDueAt).toBeNull();
    const enrollments = await db.select().from(schema.automationEnrollments).where(eq(schema.automationEnrollments.leadId, leadId));
    expect(enrollments).toHaveLength(0);
    // Tidy the imported demo lead.
    await db.update(inboundEvents).set({ externalId: `${event!.externalId}-${TAG}` }).where(eq(inboundEvents.id, event!.id));
  });
});
