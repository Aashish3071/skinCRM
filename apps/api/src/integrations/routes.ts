import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  connectMetaSchema,
  connectWhatsAppSchema,
  messagingSettingsSchema,
  normalizePhone,
  testSendSchema,
  uuidSchema,
  type ConnectionDto,
  type IntegrationsOverview,
} from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { ConnectorError, getConnectors, getMetaLeadsConnector, WhatsAppCloudConnector } from "@skincrm/connectors";
import { schema } from "@skincrm/db";
import { encryptForClinic } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest, conflict, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { whatsappConnector } from "./connections";
import { enqueueEvent, processDueInboundEvents } from "./processor";
import { sha256 } from "./webhooks";

const { integrationConnections, inboundEvents, clinics } = schema;

export function registerIntegrationRoutes(app: FastifyInstance): void {
  // --- Overview -------------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/integrations",
    auth: { capability: "integrations:read" },
    handler: async (): Promise<IntegrationsOverview> => {
      const env = getEnv();
      const tx = getTx();
      const [connections, events, clinic] = await Promise.all([
        tx.select().from(integrationConnections).orderBy(integrationConnections.createdAt),
        tx.select().from(inboundEvents).orderBy(desc(inboundEvents.receivedAt)).limit(30),
        tx.select().from(clinics).limit(1),
      ]);
      const api = env.PUBLIC_API_URL.replace(/\/$/, "");
      const c = clinic[0]!;
      return {
        connections: connections.map(serializeConnection),
        events: events.map((e) => ({
          id: e.id,
          type: e.type,
          state: e.state,
          isTest: e.isTest === 1,
          attempts: e.attempts,
          lastError: e.lastError,
          result: e.result,
          receivedAt: e.receivedAt.toISOString(),
        })),
        webhooks: { meta: `${api}/webhooks/meta`, whatsapp: `${api}/webhooks/whatsapp`, google: `${api}/webhooks/google/lead-form` },
        verifyTokens: { meta: env.META_WEBHOOK_VERIFY_TOKEN, whatsapp: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN },
        modes: { email: env.CONNECTOR_EMAIL, whatsapp: env.CONNECTOR_WHATSAPP, meta: env.CONNECTOR_META, google: env.CONNECTOR_GOOGLE },
        sending: {
          enabled: env.OUTBOUND_SENDING_ENABLED,
          promotionalApproved: c.promotionalSendingApproved,
          postalAddress: c.postalAddress,
          sendingDomain: c.sendingDomain,
          supportEmail: c.supportEmail,
          emailFrom: `noreply@${c.sendingDomain ?? "example-clinic.test"}`,
        },
      };
    },
  });

  // --- Facebook / Instagram Lead Ads ----------------------------------------
  registerRoute(app, {
    method: "PUT",
    url: "/integrations/meta",
    auth: { capability: "integrations:write" },
    body: connectMetaSchema,
    handler: async ({ body }) => {
      const check = await getMetaLeadsConnector().verifyPage(body.pageId, body.accessToken);
      if (!check.ok) throw badRequest(`Meta didn't accept that token for this page: ${check.detail}`);
      return upsertConnection("meta_lead_ads", body.pageId, check.name ?? `Page ${body.pageId}`, body.accessToken, {});
    },
  });

  // --- WhatsApp Business (Cloud API) ----------------------------------------
  registerRoute(app, {
    method: "PUT",
    url: "/integrations/whatsapp",
    auth: { capability: "integrations:write" },
    body: connectWhatsAppSchema,
    handler: async ({ body }) => {
      if (getEnv().CONNECTOR_WHATSAPP === "live") {
        const check = await new WhatsAppCloudConnector({ phoneNumberId: body.phoneNumberId, accessToken: body.accessToken }).verify();
        if (!check.ok) throw badRequest(`Meta didn't accept those details: ${check.detail}`);
      }
      return upsertConnection("whatsapp_cloud", body.phoneNumberId, body.displayPhone ?? `Number ${body.phoneNumberId}`, body.accessToken, {
        businessAccountId: body.businessAccountId ?? null,
      });
    },
  });

  // --- Google Ads lead forms: the clinic gets a key to paste into Google -------
  registerRoute(app, {
    method: "POST",
    url: "/integrations/google/key",
    auth: { capability: "integrations:write" },
    handler: async () => {
      const key = randomBytes(24).toString("base64url");
      const existing = await getTx().select().from(integrationConnections).where(eq(integrationConnections.provider, "google_lead_forms")).limit(1);
      if (existing[0]) await getTx().delete(integrationConnections).where(eq(integrationConnections.id, existing[0].id));
      const connection = await upsertConnection("google_lead_forms", sha256(key), "Google Ads lead forms", key, {});
      // Shown once. Only its hash and an encrypted copy are kept.
      return { ...connection, key };
    },
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/integrations/:id",
    auth: { capability: "integrations:write" },
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      const rows = await getTx().delete(integrationConnections).where(eq(integrationConnections.id, params.id)).returning();
      if (!rows[0]) throw notFound("No such connection.");
      await recordAudit({ action: "integration_disconnected", entityType: "integration", entityId: params.id, changeSummary: { provider: rows[0].provider } });
      return null;
    },
  });

  // --- Test leads: the full path, webhook to lead, without an ad ---------------
  registerRoute(app, {
    method: "POST",
    url: "/integrations/:provider/test-lead",
    auth: { capability: "integrations:write" },
    params: z.object({ provider: z.enum(["meta", "google"]) }),
    handler: async ({ params }) => {
      const tx = getTx();
      const provider = params.provider === "meta" ? "meta_lead_ads" : "google_lead_forms";
      const connection = (await tx.select().from(integrationConnections).where(eq(integrationConnections.provider, provider)).limit(1))[0];
      if (!connection) throw badRequest("Connect it first.");
      if (params.provider === "meta" && getMetaLeadsConnector().mode === "live") {
        throw badRequest("With a live Meta connection, use Meta's Lead Ads Testing Tool — it sends a real test lead through the webhook.");
      }
      const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      if (params.provider === "meta") {
        await enqueueEvent({ connectionId: connection.id, type: "meta_leadgen", externalId: id, isTest: true,
          payload: { leadgen_id: id, page_id: connection.externalAccountId, form_id: "test-form" } });
      } else {
        const n = id.slice(-4);
        await enqueueEvent({ connectionId: connection.id, type: "google_lead", externalId: `test-${id}`, isTest: true,
          payload: {
            lead_id: `test-${id}`, form_id: "test-form", campaign_id: "test-campaign", gcl_id: `test-gclid-${n}`, is_test: true,
            user_column_data: [
              { column_id: "FULL_NAME", string_value: `Google Test Lead ${n}` },
              { column_id: "EMAIL", string_value: `google.lead.${n}@example.test` },
              { column_id: "PHONE_NUMBER", string_value: `+1305557${n}` },
            ],
          } });
      }
      return { queued: true };
    },
  });

  /** Process queued events now rather than waiting for the worker's next tick. */
  registerRoute(app, {
    method: "POST",
    url: "/integrations/process-now",
    auth: { capability: "integrations:write" },
    handler: async () => ({ processed: await processDueInboundEvents() }),
  });

  // --- Messaging settings and test sends ---------------------------------------
  registerRoute(app, {
    method: "PATCH",
    url: "/settings/messaging",
    auth: { capability: "settings:write" },
    body: messagingSettingsSchema,
    handler: async ({ body }) => {
      const tx = getTx();
      const before = (await tx.select().from(clinics).limit(1))[0]!;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.promotionalSendingApproved !== undefined) {
        if (body.promotionalSendingApproved && !(body.postalAddress ?? before.postalAddress)) {
          throw badRequest("Add the clinic's postal address first — marketing email must show it by law.", { postalAddress: ["Required for marketing"] });
        }
        updates.promotionalSendingApproved = body.promotionalSendingApproved;
        updates.promotionalSendingApprovedAt = body.promotionalSendingApproved ? new Date() : null;
      }
      for (const key of ["postalAddress", "sendingDomain", "supportEmail"] as const) {
        if (body[key] !== undefined) updates[key] = body[key];
      }
      await tx.update(clinics).set(updates).where(eq(clinics.id, before.id));
      await recordAudit({
        action: "settings_changed",
        entityType: "clinic",
        entityId: before.id,
        changeSummary: { messaging: Object.keys(updates).filter((k) => k !== "updatedAt"), promotionalApproved: body.promotionalSendingApproved },
      });
      return { ok: true };
    },
  });

  /**
   * Send one test message to a staff member's own address or number. Bypasses
   * consent and quiet hours on purpose — it is not a message to a client — but
   * never the kill switch.
   */
  registerRoute(app, {
    method: "POST",
    url: "/integrations/test-send",
    auth: { capability: "integrations:write" },
    body: testSendSchema,
    handler: async ({ body }) => {
      const env = getEnv();
      if (!env.OUTBOUND_SENDING_ENABLED) throw badRequest("Sending is switched off for this deployment (OUTBOUND_SENDING_ENABLED).");
      const clinic = (await getTx().select().from(clinics).limit(1))[0]!;
      const key = `test:${randomUUID()}`;
      try {
        if (body.channel === "email") {
          const r = await getConnectors().email.send({
            to: body.to,
            subject: `Test email from ${clinic.name}`,
            text: `This is a test from SkinCRM. If you can read it, email sending works.\n\n${clinic.name}`,
            fromAddress: `noreply@${clinic.sendingDomain ?? "example-clinic.test"}`,
            fromName: clinic.name,
            idempotencyKey: key,
          });
          return { ok: true, detail: `Accepted by the email server (${getConnectors().email.mode === "mock" ? "mock — nothing left this machine" : r.providerMessageId}).` };
        }
        const phone = normalizePhone(body.to, clinic.country);
        if (!phone.e164) throw badRequest("That isn't a phone number we can read.");
        const r = await (await whatsappConnector()).send({
          kind: "text",
          toWaId: phone.e164.replace(/^\+/, ""),
          body: `Test message from ${clinic.name} via SkinCRM.`,
          idempotencyKey: key,
        });
        return { ok: true, detail: `Accepted by WhatsApp (${r.providerMessageId}). Note: WhatsApp only delivers free text to people who messaged you in the last 24 hours.` };
      } catch (error) {
        if (error instanceof ConnectorError) return { ok: false, detail: error.message };
        throw error;
      }
    },
  });
}

export async function upsertConnection(
  provider: "meta_lead_ads" | "whatsapp_cloud" | "google_lead_forms",
  externalAccountId: string,
  displayName: string,
  secret: string,
  config: Record<string, string | null>,
): Promise<ConnectionDto> {
  const context = getContext();
  const tx = getTx();
  const values = {
    clinicId: context.clinicId!,
    provider,
    externalAccountId,
    displayName,
    config,
    status: "healthy" as const,
    encryptedSecret: encryptForClinic(context.clinicId!, secret),
    lastCheckedAt: new Date(),
    lastError: null,
    connectedByUserId: context.userId,
    updatedAt: new Date(),
  };
  try {
    const rows = await tx
      .insert(integrationConnections)
      .values(values)
      .onConflictDoUpdate({ target: [integrationConnections.provider, integrationConnections.externalAccountId], set: values, setWhere: eq(integrationConnections.clinicId, context.clinicId!) })
      .returning();
    if (!rows[0]) throw conflict("That account is already connected to another clinic.");
    await recordAudit({ action: "integration_connected", entityType: "integration", entityId: rows[0].id, changeSummary: { provider } });
    return serializeConnection(rows[0]);
  } catch (error) {
    // RLS hides the other clinic's row, so the unique index is how we learn of it.
    const code = (error as { code?: string }).code;
    if (code === "23505" || code === "42501") throw conflict("That account is already connected to another clinic.");
    throw error;
  }
}

export function serializeConnection(c: typeof integrationConnections.$inferSelect): ConnectionDto {
  return {
    id: c.id,
    provider: c.provider,
    status: c.status,
    displayName: c.displayName,
    // The Google connection's external id is the key's hash: never shown.
    accountLabel: c.provider === "google_lead_forms"
      ? (c.config.customerId ? String(c.config.customerId).replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3") : null)
      : c.externalAccountId,
    hasSecret: Boolean(c.encryptedSecret),
    lastEventAt: c.lastEventAt?.toISOString() ?? null,
    lastError: c.lastError,
    createdAt: c.createdAt.toISOString(),
    connectedVia: c.config.via === "oauth" ? "oauth" : "manual",
    leadForms: c.provider === "google_lead_forms" && c.config.leadForms != null ? Number(c.config.leadForms) : null,
  };
}
