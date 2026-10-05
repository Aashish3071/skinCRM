/** Coexistence: past chats, phone-app replies and contacts from the WhatsApp Business app (D-95). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockWhatsAppSignupClient, setWhatsAppSignupClient } from "@skincrm/connectors";
import { SEED, authenticate, clinicIdBySlug, createTestApp, letters, resetAuthState } from "./helpers";
import { processDueInboundEvents } from "../integrations/processor";

const { integrationConnections, people, messages, conversations, leads, inboundEvents } = schema;
const STAMP = String(Date.now()).slice(-6);
const PATIENT = `1305559${STAMP.slice(-4)}`;
const BUSINESS = "13055550100";
const TAG = `wah${letters(Date.now())}`;
let app: FastifyInstance;
let admin: string;
let clinicId: string;
let signup: MockWhatsAppSignupClient;
let saved: (typeof integrationConnections.$inferSelect)[] = [];

beforeAll(async () => {
  signup = new MockWhatsAppSignupClient();
  setWhatsAppSignupClient(signup);
  delete process.env.META_APP_SECRET;
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  const { db } = getOwnerDb();
  saved = await db.select().from(integrationConnections).where(and(eq(integrationConnections.clinicId, clinicId), eq(integrationConnections.provider, "whatsapp_cloud")));
});

afterAll(async () => {
  const { db } = getOwnerDb();
  const ids = (await db.select({ id: people.id }).from(people).where(eq(people.phoneE164, `+${PATIENT}`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(messages).where(inArray(messages.personId, ids));
    await db.delete(conversations).where(inArray(conversations.personId, ids));
    await db.delete(people).where(inArray(people.id, ids));
  }
  await db.delete(inboundEvents).where(like(inboundEvents.externalId, `%${TAG}%`));
  await db.delete(integrationConnections).where(and(eq(integrationConnections.clinicId, clinicId), eq(integrationConnections.provider, "whatsapp_cloud")));
  if (saved.length) await db.insert(integrationConnections).values(saved);
  setWhatsAppSignupClient(undefined);
  await app.close();
  await closeAllConnections();
});

const webhook = (field: string, value: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: { object: "whatsapp_business_account", entry: [{ changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: BUSINESS, phone_number_id: "100000000000001" }, ...value } }] }] } });

describe("WhatsApp Business app history", () => {
  it("asks Meta for past chats when connecting the number the clinic already uses", async () => {
    const start = await app.inject({ method: "POST", url: "/integrations/whatsapp/signup/start", headers: { cookie: admin } });
    const done = await app.inject({ method: "POST", url: "/integrations/whatsapp/signup/complete", headers: { cookie: admin }, payload: {
      state: start.json().state, code: "mock-wa-code", phoneNumberId: "100000000000001", wabaId: "200000000000001", coexistence: true,
    } });
    expect(done.statusCode).toBe(200);
    expect(done.json().detail).toMatch(/Past chats/);
    expect(signup.syncRequested.has("100000000000001")).toBe(true);
  });

  it("files past chats and phone-app replies into the patient's thread — no lead, nothing unread, no duplicates", async () => {
    const day = 86_400;
    const now = Math.floor(Date.now() / 1000);
    const history = { history: [{ metadata: { phase: 0 }, threads: [{ id: PATIENT, messages: [
      { id: `h1-${TAG}`, from: PATIENT, timestamp: String(now - 10 * day), type: "text", text: { body: "Hi, how much is a peel?" } },
      { id: `h2-${TAG}`, from: BUSINESS, timestamp: String(now - 10 * day + 600), type: "text", text: { body: "From $120 — want to book?" } },
    ] }] }] };
    expect((await webhook("history", history)).statusCode).toBe(200);
    await webhook("history", history); // Meta may resend a chunk.
    await webhook("smb_message_echoes", { message_echoes: [{ id: `e1-${TAG}`, from: BUSINESS, to: PATIENT, timestamp: String(now - 60), type: "text", text: { body: "See you Tuesday!" } }] });
    await webhook("smb_app_state_sync", { state_sync: [{ type: "contact", action: "add", contact: { full_name: "Lucia Moreno", phone_number: PATIENT } }] });
    await processDueInboundEvents();
    await processDueInboundEvents();

    const { db } = getOwnerDb();
    const states = await db.select().from(inboundEvents).where(like(inboundEvents.externalId, `%${TAG}%`));
    expect(states.every((q) => q.state === "processed")).toBe(true);
    const [person] = await db.select().from(people).where(eq(people.phoneE164, `+${PATIENT}`));
    expect(person).toBeTruthy();
    expect(person!.displayName).toBe("Lucia Moreno");
    const rows = await db.select().from(messages).where(eq(messages.personId, person!.id));
    expect(rows.map((m) => [m.direction, m.renderedBody]).sort()).toEqual([
      ["inbound", "Hi, how much is a peel?"],
      ["outbound", "From $120 — want to book?"],
      ["outbound", "See you Tuesday!"],
    ].sort());
    expect(rows.find((m) => m.renderedBody === "Hi, how much is a peel?")!.createdAt.getTime()).toBe((now - 10 * day) * 1000);
    const [thread] = await db.select().from(conversations).where(eq(conversations.personId, person!.id));
    expect(thread!.unreadCount).toBe(0);
    expect(thread!.lastPreview).toBe("See you Tuesday!");
    expect(await db.select().from(leads).where(eq(leads.personId, person!.id))).toHaveLength(0);
    // Tag the queue rows for clean-up.
    const events = await db.select().from(inboundEvents).where(like(inboundEvents.externalId, `${PATIENT}:%`));
    for (const e of events) await db.update(inboundEvents).set({ externalId: `${e.externalId}-${TAG}` }).where(eq(inboundEvents.id, e.id));
  });
});
