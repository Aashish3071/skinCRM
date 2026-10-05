import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@skincrm/config";
import { schema, withoutTenantScope } from "@skincrm/db";
import { verifyReplyToken } from "@skincrm/security";
import { logger } from "../logger";
import { runAsSystem } from "../automations/system-context";
import {
  enqueueEvent,
  type GoogleLeadPayload,
  type MetaLeadgenPayload,
  type WhatsAppMessagePayload,
  type WhatsAppStatusPayload,
} from "./processor";

const { integrationConnections } = schema;

/**
 * Public webhooks for Meta Lead Ads, WhatsApp Cloud and Google Ads lead forms
 * (PRD INT-01…04).
 *
 * Every one does the same four things and nothing slow: verify the sender,
 * find the clinic from the account id, queue the event, answer 200. The worker
 * does the rest (D-71). An unknown account is acknowledged and dropped — a
 * non-200 would only make the provider retry something we cannot use.
 *
 * These are plain Fastify routes rather than `registerRoute`: they have no
 * session and must see the raw body to check Meta's signature.
 */
export function registerWebhooks(app: FastifyInstance): void {
  // --- Meta subscription handshake (both Lead Ads and WhatsApp) -------------
  const handshake = (expected: () => string) => async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], expected())) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send({ error: { code: "forbidden", message: "Verification failed" } });
  };
  app.get("/webhooks/meta", handshake(() => getEnv().META_WEBHOOK_VERIFY_TOKEN));
  app.get("/webhooks/whatsapp", handshake(() => getEnv().WHATSAPP_WEBHOOK_VERIFY_TOKEN));

  // --- Meta Lead Ads --------------------------------------------------------
  app.post("/webhooks/meta", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!verifyMetaSignature(request)) return reply.code(401).send({ error: { code: "bad_signature", message: "Invalid signature" } });
    const body = request.body as { object?: string; entry?: { id?: string; changes?: { field?: string; value?: MetaLeadgenPayload }[] }[] };
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
        const value = change.value;
        await routeToClinic("meta_lead_ads", String(value.page_id ?? entry.id ?? ""), (connectionId) =>
          enqueueEvent({ connectionId, type: "meta_leadgen", externalId: String(value.leadgen_id), payload: value }),
        );
      }
    }
    return reply.send({ ok: true });
  });

  // --- WhatsApp Cloud: messages and delivery statuses -----------------------
  app.post("/webhooks/whatsapp", { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!verifyMetaSignature(request)) return reply.code(401).send({ error: { code: "bad_signature", message: "Invalid signature" } });
    type Value = {
      metadata?: { phone_number_id?: string };
      contacts?: { wa_id?: string; profile?: { name?: string } }[];
      messages?: WhatsAppMessagePayload[];
      statuses?: WhatsAppStatusPayload[];
    };
    const body = request.body as { entry?: { changes?: { field?: string; value?: Value }[] }[] };
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!value || !phoneNumberId) continue;
        // Coexistence (D-95): the WhatsApp Business app on the clinic's phone.
        if (change.field === "history" || change.field === "smb_message_echoes" || change.field === "smb_app_state_sync") {
          await routeToClinic("whatsapp_cloud", phoneNumberId, (connectionId) => enqueueAppEvents(connectionId, change.field!, value as AppValue));
          continue;
        }
        if (change.field !== "messages") continue;
        await routeToClinic("whatsapp_cloud", phoneNumberId, async (connectionId) => {
          for (const m of value.messages ?? []) {
            const profileName = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
            await enqueueEvent({ connectionId, type: "whatsapp_message", externalId: m.id, payload: { ...m, profileName } });
          }
          for (const s of value.statuses ?? []) {
            await enqueueEvent({ connectionId, type: "whatsapp_status", externalId: `${s.id}:${s.status}`, payload: s });
          }
        });
      }
    }
    return reply.send({ ok: true });
  });

  // --- Postmark (D-96): deliveries, bounces, complaints, unsubscribes, replies ---
  // Postmark calls these with the basic-auth credentials set in its webhook URLs.
  app.post("/webhooks/postmark/events", { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!postmarkAuthorized(request)) return reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized" } });
    const body = request.body as { RecordType?: string; MessageID?: string; ID?: number | string; Metadata?: Record<string, string> };
    const clinicId = body.Metadata?.clinicId;
    if (!body.RecordType || !body.MessageID || !clinicId || !/^[0-9a-f-]{36}$/.test(clinicId)) return reply.send({ ok: true, ignored: true });
    // Only clinics that exist; the event is checked against the message in the processor.
    const [clinic] = await withoutTenantScope("postmark: resolve clinic", (db) => db.select({ id: schema.clinics.id }).from(schema.clinics).where(eq(schema.clinics.id, clinicId)).limit(1));
    if (!clinic) return reply.send({ ok: true, ignored: true });
    await runAsSystem(clinic.id, () => enqueueEvent({ connectionId: null, type: "email_event", externalId: `${body.RecordType}:${body.MessageID}:${body.ID ?? ""}`.slice(0, 200), payload: body }), { correlationId: "webhook-postmark" });
    return reply.send({ ok: true });
  });

  app.post("/webhooks/postmark/inbound", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!postmarkAuthorized(request)) return reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized" } });
    const body = request.body as { MessageID?: string; MailboxHash?: string; FromFull?: { Email?: string }; From?: string };
    if (!body.MessageID) return reply.send({ ok: true, ignored: true });
    const from = (body.FromFull?.Email ?? body.From ?? "").trim().toLowerCase();
    // Whose conversation: the signed token in the Reply-To address, else the
    // sender's address when exactly one patient anywhere has it.
    const tokenPerson = body.MailboxHash ? verifyReplyToken(body.MailboxHash) : null;
    const match = await withoutTenantScope("postmark inbound: resolve patient", async (db) =>
      tokenPerson
        ? db.select({ id: schema.people.id, clinicId: schema.people.clinicId }).from(schema.people).where(eq(schema.people.id, tokenPerson)).limit(1)
        : from
          ? db.select({ id: schema.people.id, clinicId: schema.people.clinicId }).from(schema.people).where(eq(schema.people.emailNormalized, from)).limit(2)
          : [],
    );
    if (match.length !== 1) {
      logger.info({ matched: match.length }, "Inbound email with no single matching patient; ignored");
      return reply.send({ ok: true, ignored: true });
    }
    await runAsSystem(match[0]!.clinicId, () => enqueueEvent({ connectionId: null, type: "email_inbound", externalId: body.MessageID!, payload: { ...body, personId: match[0]!.id } }), { correlationId: "webhook-postmark" });
    return reply.send({ ok: true });
  });

  // --- Google Ads lead-form extension ----------------------------------------
  app.post("/webhooks/google/lead-form", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = request.body as GoogleLeadPayload & { google_key?: string };
    if (!body?.lead_id || !body.google_key) {
      return reply.code(400).send({ error: { code: "bad_request", message: "lead_id and google_key are required" } });
    }
    // The key is the credential. Stored hashed for lookup, so a match proves it.
    const found = await routeToClinic("google_lead_forms", sha256(body.google_key), (connectionId) => {
      const { google_key: _secret, ...payload } = body;
      return enqueueEvent({ connectionId, type: "google_lead", externalId: String(body.lead_id), payload, isTest: Boolean(body.is_test) });
    });
    if (!found) return reply.code(401).send({ error: { code: "unknown_key", message: "Unknown key" } });
    return reply.send({});
  });
}

/**
 * Find the clinic that owns this account and run `fn` inside it. The lookup
 * crosses tenants (a webhook has no session), so it uses the owner connection
 * and reads only the ids.
 */
async function routeToClinic(
  provider: "meta_lead_ads" | "whatsapp_cloud" | "google_lead_forms",
  externalAccountId: string,
  fn: (connectionId: string) => Promise<unknown>,
): Promise<boolean> {
  if (!externalAccountId) return false;
  const match = await withoutTenantScope(`webhook: resolve clinic for ${provider}`, async (db) =>
    db
      .select({ id: integrationConnections.id, clinicId: integrationConnections.clinicId })
      .from(integrationConnections)
      .where(and(eq(integrationConnections.provider, provider), eq(integrationConnections.externalAccountId, externalAccountId)))
      .limit(1),
  );
  if (!match[0]) {
    logger.info({ provider }, "Webhook for an account no clinic has connected; ignored");
    return false;
  }
  await runAsSystem(match[0].clinicId, () => fn(match[0]!.id), { correlationId: `webhook-${provider}` });
  return true;
}

/**
 * Meta signs every webhook with the app secret (X-Hub-Signature-256). Without
 * a configured secret, unsigned calls are accepted only outside production, so
 * the mock flow and local testing work.
 */
function verifyMetaSignature(request: FastifyRequest): boolean {
  const secret = getEnv().META_APP_SECRET;
  if (!secret) return getEnv().NODE_ENV !== "production";
  const header = request.headers["x-hub-signature-256"];
  const raw = (request as FastifyRequest & { rawBody?: string }).rawBody;
  if (typeof header !== "string" || !raw || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(header.slice(7), expected);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type AppMessage = { id: string; from?: string; to?: string; timestamp?: string; type?: string; text?: { body?: string } };
type AppValue = {
  metadata?: { display_phone_number?: string };
  history?: { threads?: { id: string; messages?: AppMessage[] }[] }[];
  message_echoes?: AppMessage[];
  state_sync?: { type?: string; action?: string; contact?: { full_name?: string; phone_number?: string } }[];
};

/** One queued event per message or contact, so a retry never repeats the rest. */
async function enqueueAppEvents(connectionId: string, field: string, value: AppValue): Promise<void> {
  const business = (value.metadata?.display_phone_number ?? "").replace(/\D/g, "");
  if (field === "history") {
    for (const chunk of value.history ?? []) {
      for (const thread of chunk.threads ?? []) {
        for (const m of thread.messages ?? []) {
          const fromPatient = (m.from ?? "").replace(/\D/g, "") !== business;
          await enqueueEvent({ connectionId, type: "whatsapp_history", externalId: m.id, payload: { waId: thread.id, direction: fromPatient ? "inbound" : "outbound", message: m } });
        }
      }
    }
  } else if (field === "smb_message_echoes") {
    for (const m of value.message_echoes ?? []) {
      if (m.to) await enqueueEvent({ connectionId, type: "whatsapp_echo", externalId: m.id, payload: { waId: m.to, direction: "outbound", message: m } });
    }
  } else {
    for (const [i, item] of (value.state_sync ?? []).entries()) {
      if (item.type !== "contact" || item.action === "remove" || !item.contact?.phone_number) continue;
      await enqueueEvent({ connectionId, type: "whatsapp_contact", externalId: `${item.contact.phone_number}:${item.contact.full_name ?? ""}:${i}`.slice(0, 200), payload: item.contact });
    }
  }
}

/** Basic auth from the webhook URL. Without configured credentials only development accepts calls. */
function postmarkAuthorized(request: FastifyRequest): boolean {
  const env = getEnv();
  if (!env.POSTMARK_WEBHOOK_USER || !env.POSTMARK_WEBHOOK_PASSWORD) return env.NODE_ENV !== "production";
  const header = request.headers.authorization ?? "";
  const expected = Buffer.from(`Basic ${Buffer.from(`${env.POSTMARK_WEBHOOK_USER}:${env.POSTMARK_WEBHOOK_PASSWORD}`).toString("base64")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

