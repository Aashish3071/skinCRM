/** Postmark email: replies into the Inbox, bounces, complaints and unsubscribes (D-96). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { resetEnvCache } from "@skincrm/config";
import { MockEmailConnector, MockWhatsAppConnector, PostmarkEmailConnector, resetConnectors, setConnectors } from "@skincrm/connectors";
import { createReplyToken, verifyReplyToken } from "@skincrm/security";
import { SEED, authenticate, clinicIdBySlug, createTestApp, letters, resetAuthState } from "./helpers";
import { processDueInboundEvents } from "../integrations/processor";

const { people, consentRecords, messages, conversations, suppressions, activities, inboundEvents } = schema;
const TAG = `pm${letters(Date.now())}`;
const saved = { ...process.env };
let app: FastifyInstance;
let admin: string;
let clinicId: string;
let email: MockEmailConnector;
let personId: string;

beforeAll(async () => {
  Object.assign(process.env, { EMAIL_PROVIDER: "postmark", POSTMARK_INBOUND_ADDRESS: "inbox@inbound.example.test", OUTBOUND_SENDING_ENABLED: "true" });
  delete process.env.POSTMARK_WEBHOOK_USER;
  delete process.env.POSTMARK_WEBHOOK_PASSWORD;
  resetEnvCache();
  email = new MockEmailConnector();
  setConnectors({ email, whatsapp: new MockWhatsAppConnector() });
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  const { db } = getOwnerDb();
  const [p] = await db.insert(people).values({ clinicId, firstName: "Grace", lastName: TAG, displayName: `Grace ${TAG}`, emailRaw: `grace.${TAG}@example.test`, emailNormalized: `grace.${TAG}@example.test` }).returning();
  personId = p!.id;
});

afterAll(async () => {
  const { db } = getOwnerDb();
  await db.delete(messages).where(eq(messages.personId, personId));
  await db.delete(conversations).where(eq(conversations.personId, personId));
  await db.delete(suppressions).where(like(suppressions.destination, `%${TAG}%`));
  await db.delete(consentRecords).where(eq(consentRecords.personId, personId));
  await db.delete(activities).where(eq(activities.personId, personId));
  await db.delete(schema.deliveryAttempts).where(eq(schema.deliveryAttempts.personId, personId));
  await db.delete(inboundEvents).where(like(inboundEvents.externalId, `%${TAG}%`));
  await db.delete(people).where(eq(people.id, personId));
  process.env = { ...saved };
  resetEnvCache();
  resetConnectors();
  await app.close();
  await closeAllConnections();
});

async function sendEmail(body: string) {
  const r = await app.inject({ method: "POST", url: "/messages", headers: { cookie: admin }, payload: { personId, channel: "email", subject: "About your visit", body } });
  expect(r.statusCode).toBeLessThan(300);
  return r.json();
}

describe("Postmark connector (fake network)", () => {
  it("uses the marketing stream for promotional mail, no tracking, and suppresses on 406", async () => {
    const bodies: Record<string, unknown>[] = [];
    let status = 200;
    const client = new PostmarkEmailConnector({ serverToken: "t", transactionalStream: "outbound", broadcastStream: "broadcast" }, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(status === 200 ? { ErrorCode: 0, MessageID: "pm-1", SubmittedAt: new Date().toISOString() } : { ErrorCode: 406, Message: "Inactive recipient" }), { status });
    });
    const base = { to: "a@example.test", subject: "Hi", text: "Hello", fromAddress: "noreply@clinic.test", fromName: "Clinic", idempotencyKey: "k1" };
    expect((await client.send({ ...base, classification: "promotional", replyTo: "inbox+abc@inbound.test", metadata: { clinicId: "c1" } })).providerMessageId).toBe("pm-1");
    expect(bodies[0]).toMatchObject({ MessageStream: "broadcast", TrackOpens: false, TrackLinks: "None", ReplyTo: "inbox+abc@inbound.test", Metadata: { clinicId: "c1" } });
    await client.send(base);
    expect(bodies[1]).toMatchObject({ MessageStream: "outbound" });
    status = 422;
    await expect(client.send(base)).rejects.toMatchObject({ options: { permanentSuppression: true, retryable: false } });
  });

  it("reply tokens can't be guessed or edited", () => {
    const token = createReplyToken(personId);
    expect(token).toHaveLength(44);
    expect(verifyReplyToken(token)).toBe(personId);
    expect(verifyReplyToken(`${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`)).toBeNull();
    expect(verifyReplyToken("not-a-token")).toBeNull();
  });
});

describe("email in and out", () => {
  it("a patient's reply lands in an email thread in the Inbox, and staff answer by email", async () => {
    await sendEmail("Your consultation is confirmed for Tuesday.");
    const sent = email.outbox().at(-1)!;
    expect(sent.replyTo).toMatch(/^inbox\+[0-9a-f]{44}@inbound\.example\.test$/);
    const token = sent.replyTo!.split("+")[1]!.split("@")[0]!;

    const inbound = await app.inject({ method: "POST", url: "/webhooks/postmark/inbound", payload: {
      MessageID: `in-${TAG}`, MailboxHash: token, FromFull: { Email: `grace.${TAG}@example.test` }, Subject: "Re: About your visit",
      TextBody: "Can we make it 3pm?\n\nOn Tue, Clinic wrote:\n> Your consultation…", StrippedTextReply: "Can we make it 3pm?", Date: new Date().toUTCString(),
    } });
    expect(inbound.statusCode).toBe(200);
    await processDueInboundEvents();

    const { db } = getOwnerDb();
    const [thread] = await db.select().from(conversations).where(and(eq(conversations.personId, personId), eq(conversations.channel, "email")));
    expect(thread).toBeTruthy();
    expect(thread!.unreadCount).toBe(1);
    const reply = (await db.select().from(messages).where(and(eq(messages.conversationId, thread!.id), eq(messages.direction, "inbound"))))[0];
    expect(reply!.renderedBody).toBe("Can we make it 3pm?");

    const answer = await app.inject({ method: "POST", url: `/conversations/${thread!.id}/reply`, headers: { cookie: admin }, payload: { body: "3pm works — see you then." } });
    expect(answer.statusCode).toBeLessThan(300);
    expect(email.outbox().at(-1)).toMatchObject({ subject: "Re: About your visit", body: "3pm works — see you then." });

    // A forged token is ignored rather than filed under someone.
    const forged = await app.inject({ method: "POST", url: "/webhooks/postmark/inbound", payload: { MessageID: `forged-${TAG}`, MailboxHash: `${token.slice(0, 32)}${"0".repeat(12)}`, FromFull: { Email: "x@unknown.test" }, TextBody: "hi" } });
    expect(forged.json()).toMatchObject({ ignored: true });
  });

  it("a hard bounce marks the email bounced and stops future email; a complaint withdraws marketing consent", async () => {
    await sendEmail("Reminder: bring your ID.");
    const { db } = getOwnerDb();
    const [row] = await db.select().from(messages).where(and(eq(messages.personId, personId), eq(messages.direction, "outbound"))).orderBy(messages.createdAt);
    const last = (await db.select().from(messages).where(and(eq(messages.personId, personId), eq(messages.direction, "outbound")))).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(row).toBeTruthy();

    await app.inject({ method: "POST", url: "/webhooks/postmark/events", payload: {
      RecordType: "Bounce", ID: 42, MessageID: last.providerMessageId, Type: "HardBounce", Inactive: true, Email: `grace.${TAG}@example.test`,
      Description: "The server was unable to deliver your message", Metadata: { clinicId }, BouncedAt: new Date().toISOString(),
    } });
    await app.inject({ method: "POST", url: "/webhooks/postmark/events", payload: {
      RecordType: "SpamComplaint", ID: 43, MessageID: last.providerMessageId, Email: `grace.${TAG}@example.test`, Metadata: { clinicId },
    } });
    await processDueInboundEvents();

    const [after] = await db.select().from(messages).where(eq(messages.id, last.id));
    expect(after!.state).toBe("bounced");
    const blocks = await db.select().from(suppressions).where(eq(suppressions.destination, `grace.${TAG}@example.test`));
    // One block on the address; whichever report the queue handled first names it.
    expect(blocks).toHaveLength(1);
    expect(["hard_bounce", "spam_complaint"]).toContain(blocks[0]!.reason);
    const consent = await db.select().from(consentRecords).where(and(eq(consentRecords.personId, personId), eq(consentRecords.purpose, "promotional")));
    expect(consent.some((c) => c.status === "withdrawn")).toBe(true);

    const blocked = await sendEmail("Anything else?");
    expect(JSON.stringify(blocked)).toMatch(/suppressed|opted_out|blocked/);
    // Tag the events for clean-up.
    const events = await db.select().from(inboundEvents).where(inArray(inboundEvents.type, ["email_event", "email_inbound"]));
    for (const e of events.filter((x) => x.externalId.includes(last.providerMessageId ?? "§") || x.externalId.includes(TAG))) {
      if (!e.externalId.includes(TAG)) await db.update(inboundEvents).set({ externalId: `${e.externalId}-${TAG}`.slice(0, 250) }).where(eq(inboundEvents.id, e.id));
    }
  });

  it("refuses webhook calls without the configured credentials", async () => {
    Object.assign(process.env, { POSTMARK_WEBHOOK_USER: "postmark", POSTMARK_WEBHOOK_PASSWORD: "a-long-webhook-password-123" });
    resetEnvCache();
    const none = await app.inject({ method: "POST", url: "/webhooks/postmark/events", payload: { RecordType: "Delivery", MessageID: "x", Metadata: { clinicId } } });
    expect(none.statusCode).toBe(401);
    const auth = `Basic ${Buffer.from("postmark:a-long-webhook-password-123").toString("base64")}`;
    const ok = await app.inject({ method: "POST", url: "/webhooks/postmark/events", headers: { authorization: auth }, payload: { RecordType: "Delivery", MessageID: `none-${TAG}`, Metadata: { clinicId } } });
    expect(ok.statusCode).toBe(200);
    delete process.env.POSTMARK_WEBHOOK_USER;
    delete process.env.POSTMARK_WEBHOOK_PASSWORD;
    resetEnvCache();
  });
});
