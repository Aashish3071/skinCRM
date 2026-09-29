/** "Connect WhatsApp" — Embedded Signup (D-88), on the demo client and a fake network. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { LiveWhatsAppSignupClient, MockWhatsAppSignupClient, setWhatsAppSignupClient } from "@skincrm/connectors";
import { decryptForClinic } from "@skincrm/security";
import { SEED, authenticate, clinicIdBySlug, createTestApp, resetAuthState } from "./helpers";

const { integrationConnections } = schema;
let app: FastifyInstance;
let admin: string;
let clinicId: string;
let client: MockWhatsAppSignupClient;
let saved: (typeof integrationConnections.$inferSelect)[] = [];
const where = () => and(eq(integrationConnections.clinicId, clinicId), eq(integrationConnections.provider, "whatsapp_cloud"));

beforeAll(async () => {
  client = new MockWhatsAppSignupClient();
  setWhatsAppSignupClient(client);
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  saved = await getOwnerDb().db.select().from(integrationConnections).where(where());
});
afterAll(async () => {
  const { db } = getOwnerDb();
  await db.delete(integrationConnections).where(where());
  if (saved.length) await db.insert(integrationConnections).values(saved);
  setWhatsAppSignupClient(undefined);
  await app.close();
  await closeAllConnections();
});

const call = (url: string, payload?: unknown) => app.inject({ method: "POST", url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });

async function signUp(body: Record<string, unknown>) {
  const start = await call("/integrations/whatsapp/signup/start");
  expect(start.statusCode).toBe(200);
  expect(start.json()).toMatchObject({ mode: "mock", appId: null });
  const state = start.json().state as string;
  return { state, response: await call("/integrations/whatsapp/signup/complete", { state, code: "mock-wa-code", phoneNumberId: "100000000000001", wabaId: "200000000000001", ...body }) };
}

describe("Connect WhatsApp", () => {
  it("a new number is registered, stored encrypted with its PIN, and replaces the old connection", async () => {
    const { state, response } = await signUp({ coexistence: false });
    expect(response.statusCode).toBe(200);
    expect(response.json().connection).toMatchObject({ provider: "whatsapp_cloud", connectedVia: "oauth", accountLabel: "100000000000001", displayName: "+1 305-555-0100" });
    expect(client.registered.has("100000000000001")).toBe(true);

    const rows = await getOwnerDb().db.select().from(integrationConnections).where(where());
    expect(rows).toHaveLength(1);
    expect(decryptForClinic(clinicId, rows[0]!.encryptedSecret!)).toBe("mock-wa-business-token");
    expect(decryptForClinic(clinicId, rows[0]!.config.pinSealed!)).toMatch(/^\d{6}$/);
    expect(rows[0]!.config.businessAccountId).toBe("200000000000001");

    // The state works once.
    const again = await call("/integrations/whatsapp/signup/complete", { state, code: "mock-wa-code", phoneNumberId: "100000000000001", wabaId: "200000000000001" });
    expect(again.statusCode).toBe(400);
  });

  it("a number kept on the WhatsApp Business app (coexistence) is not re-registered", async () => {
    client.registered.clear();
    const { response } = await signUp({ coexistence: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().detail).toMatch(/Keep using the WhatsApp Business app/);
    expect(client.registered.size).toBe(0);
    const [row] = await getOwnerDb().db.select().from(integrationConnections).where(where());
    expect(row!.config).toMatchObject({ coexistence: "true", pinSealed: null });
  });

  it("refuses ids that aren't Meta's numeric ids, and non-admins", async () => {
    const { response } = await signUp({ phoneNumberId: "abc", coexistence: false });
    expect(response.statusCode).toBe(400);
    const frontDesk = await authenticate(app, SEED.frontDesk);
    const denied = await app.inject({ method: "POST", url: "/integrations/whatsapp/signup/start", headers: { cookie: frontDesk } });
    expect(denied.statusCode).toBe(403);
  });
});

describe("live client (fake network)", () => {
  it("exchanges the code, subscribes the WABA, registers with the PIN, and reads the number", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("oauth/access_token")) return json({ access_token: "biz" });
      if (url.includes("?fields=")) return json({ display_phone_number: "+1 305-555-0199", verified_name: "Sunshine" });
      return json({ success: true });
    };
    const live = new LiveWhatsAppSignupClient({ appId: "app", appSecret: "secret" }, fake);
    expect(await live.exchangeCode("c")).toBe("biz");
    await live.subscribeApp("2000", "biz");
    await live.registerNumber("1000", "biz", "123456");
    expect(await live.numberDetails("1000", "biz")).toEqual({ displayPhone: "+1 305-555-0199", verifiedName: "Sunshine" });
    expect(calls[1]!.url).toContain("2000/subscribed_apps");
    expect(calls[2]).toMatchObject({ body: { messaging_product: "whatsapp", pin: "123456" } });
    await expect(live.subscribeApp("../me", "biz")).rejects.toThrow();
  });
});
