import { eq, sql } from "drizzle-orm";
import { getMetaLeadsConnector } from "@skincrm/connectors";
import { schema, withoutTenantScope } from "@skincrm/db";
import { decryptForClinic, encryptForClinic } from "@skincrm/security";
import type { InboundEventType } from "@skincrm/contracts";
import { getContext, getTx } from "../context";
import { logger } from "../logger";
import { ingestSubmission, type IntakeInput } from "../intake/pipeline";
import { receiveInboundWhatsApp } from "../inbox/service";
import { runAsSystem } from "../automations/system-context";
import { markConnection, secretOf } from "./connections";

const { inboundEvents, integrationConnections, clinics, messages } = schema;

const MAX_ATTEMPTS = 6;

/** Queue one provider event. Idempotent: a redelivered webhook is a no-op. */
export async function enqueueEvent(params: {
  connectionId: string | null;
  type: InboundEventType;
  externalId: string;
  payload: unknown;
  isTest?: boolean;
}): Promise<boolean> {
  const clinicId = getContext().clinicId!;
  const inserted = await getTx()
    .insert(inboundEvents)
    .values({
      clinicId,
      connectionId: params.connectionId,
      type: params.type,
      externalId: params.externalId,
      encryptedPayload: encryptForClinic(clinicId, JSON.stringify(params.payload)),
      isTest: params.isTest ? 1 : 0,
    })
    .onConflictDoNothing({ target: [inboundEvents.clinicId, inboundEvents.type, inboundEvents.externalId] })
    .returning({ id: inboundEvents.id });
  return inserted.length > 0;
}

// --- Payload shapes ---------------------------------------------------------

export interface MetaLeadgenPayload {
  leadgen_id: string;
  page_id: string;
  form_id?: string;
  ad_id?: string;
  adgroup_id?: string;
  created_time?: number;
}

export interface GoogleLeadPayload {
  lead_id: string;
  form_id?: number | string;
  campaign_id?: number | string;
  adgroup_id?: number | string;
  creative_id?: number | string;
  gcl_id?: string;
  is_test?: boolean;
  user_column_data?: { column_id?: string; column_name?: string; string_value?: string }[];
}

export interface WhatsAppMessagePayload {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  profileName?: string | null;
  referral?: { source_id?: string; source_type?: string; ctwa_clid?: string } | null;
}

export interface WhatsAppStatusPayload {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp?: string;
  errors?: { code?: number; title?: string }[];
}

// --- Processing ---------------------------------------------------------------

async function processEvent(eventId: string): Promise<void> {
  const tx = getTx();
  const event = (await tx.select().from(inboundEvents).where(eq(inboundEvents.id, eventId)).limit(1))[0];
  if (!event || event.state !== "pending") return;

  const payload = JSON.parse(decryptForClinic(event.clinicId, event.encryptedPayload)) as unknown;
  const clinic = (await tx.select({ country: clinics.country }).from(clinics).limit(1))[0];
  const country = clinic?.country ?? "US";
  let result: string;

  switch (event.type) {
    case "meta_leadgen": {
      const p = payload as MetaLeadgenPayload;
      const connection = event.connectionId
        ? (await tx.select().from(integrationConnections).where(eq(integrationConnections.id, event.connectionId)).limit(1))[0]
        : null;
      const token = connection ? secretOf(connection) : null;
      if (!token && getMetaLeadsConnector().mode === "live") throw new Error("The Facebook page is not connected (no access token).");
      const lead = await getMetaLeadsConnector().fetchLead(p.leadgen_id, token ?? "");
      result = await ingest(
        {
          platform: "meta",
          source: "meta_lead_ad",
          externalId: lead.id,
          submittedAt: lead.createdTime ? new Date(lead.createdTime) : null,
          ...personFromAnswers(lead.fields),
          attribution: {
            formId: lead.formId ?? p.form_id ?? null,
            adId: lead.adId ?? p.ad_id ?? null,
            adsetId: lead.adsetId ?? p.adgroup_id ?? null,
            campaignId: lead.campaignId,
            accountId: p.page_id,
          },
          consent: [{ channel: "email", purpose: "operational", source: "ad_platform_form" }],
          rawPayload: { webhook: p, lead },
          isTest: event.isTest === 1,
          clinicCountry: country,
        },
      );
      if (connection) await markConnection(connection.id, { ok: true });
      break;
    }

    case "google_lead": {
      const p = payload as GoogleLeadPayload;
      const answers: Record<string, string> = {};
      for (const c of p.user_column_data ?? []) {
        if (c.string_value) answers[(c.column_id ?? c.column_name ?? "answer").toLowerCase()] = c.string_value;
      }
      result = await ingest({
        platform: "google",
        source: "google_lead_form",
        externalId: p.lead_id,
        ...personFromAnswers(answers),
        attribution: {
          formId: p.form_id != null ? String(p.form_id) : null,
          campaignId: p.campaign_id != null ? String(p.campaign_id) : null,
          adsetId: p.adgroup_id != null ? String(p.adgroup_id) : null,
          adId: p.creative_id != null ? String(p.creative_id) : null,
          clickId: p.gcl_id ?? null,
        },
        consent: [{ channel: "email", purpose: "operational", source: "ad_platform_form" }],
        rawPayload: p,
        isTest: Boolean(p.is_test) || event.isTest === 1,
        clinicCountry: country,
      });
      if (event.connectionId) await markConnection(event.connectionId, { ok: true });
      break;
    }

    case "whatsapp_message": {
      const p = payload as WhatsAppMessagePayload;
      const body = p.type === "text" ? (p.text?.body ?? "") : `[${p.type} — open WhatsApp on the phone to see it]`;
      const outcome = await receiveInboundWhatsApp({
        waId: p.from,
        profileName: p.profileName,
        body,
        providerMessageId: p.id,
        receivedAt: p.timestamp ? new Date(Number(p.timestamp) * 1000) : undefined,
      });
      result = `conversation:${outcome.conversationId}`;
      if (event.connectionId) await markConnection(event.connectionId, { ok: true });
      break;
    }

    case "whatsapp_status": {
      const p = payload as WhatsAppStatusPayload;
      const at = p.timestamp ? new Date(Number(p.timestamp) * 1000) : new Date();
      const updates =
        p.status === "delivered"
          ? { state: "delivered" as const, deliveredAt: at }
          : p.status === "read"
            ? { state: "read" as const, readAt: at }
            : p.status === "failed"
              ? { state: "failed" as const, failedAt: at, failureDetail: p.errors?.[0]?.title ?? "WhatsApp could not deliver it" }
              : null;
      if (updates) {
        // Never move backwards: a late "delivered" must not overwrite "read".
        await tx
          .update(messages)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            sql`${messages.providerMessageId} = ${p.id} and not (${messages.state} = 'read' and ${updates.state} = 'delivered')`,
          );
      }
      result = `status:${p.status}`;
      break;
    }
  }

  await tx
    .update(inboundEvents)
    .set({ state: "processed", result, processedAt: new Date(), lockedUntil: null, lastError: null })
    .where(eq(inboundEvents.id, event.id));
}

async function ingest(input: IntakeInput): Promise<string> {
  const outcome = await ingestSubmission(input);
  if (outcome.status === "created") return `lead:${outcome.leadId}`;
  if (outcome.status === "duplicate") return "duplicate";
  throw new Error(outcome.reason);
}

/**
 * Turn form answers into person fields. Meta and Google both use a handful of
 * standard keys; anything else becomes part of the inquiry note so no answer
 * is lost.
 */
export function personFromAnswers(answers: Record<string, string>) {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (answers[k]?.trim()) return answers[k]!.trim();
    return null;
  };
  const full = pick("full_name", "name");
  const [firstFromFull, ...restFromFull] = (full ?? "").split(/\s+/);
  const known = new Set(["full_name", "name", "first_name", "last_name", "email", "phone_number", "phone"]);
  const extra = Object.entries(answers)
    .filter(([k, v]) => !known.has(k) && v)
    .map(([k, v]) => `${k.replace(/_/g, " ").replace(/\?$/, "")}: ${v}`);
  return {
    firstName: pick("first_name") ?? (firstFromFull || null),
    lastName: pick("last_name") ?? (restFromFull.join(" ") || null),
    email: pick("email"),
    phone: pick("phone_number", "phone"),
    inquiryNote: extra.length ? `Form answers:\n${extra.join("\n")}` : null,
  };
}

// --- Worker job -----------------------------------------------------------------

/** Claim due events across clinics and process each in its own clinic. */
export async function processDueInboundEvents(limit = 25, now = new Date()): Promise<number> {
  const claimed = await withoutTenantScope("worker: claim due inbound provider events across clinics", async (db) => {
    const result = await db.execute<{ id: string; clinic_id: string }>(sql`
      update inbound_events set locked_until = ${now.toISOString()}::timestamptz + interval '2 minutes'
      where id in (
        select id from inbound_events
        where state = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz
          and (locked_until is null or locked_until < ${now.toISOString()}::timestamptz)
        order by next_attempt_at limit ${limit}
        for update skip locked
      )
      returning id, clinic_id
    `);
    return [...result];
  });

  for (const row of claimed) {
    try {
      await runAsSystem(row.clinic_id, () => processEvent(row.id), { correlationId: `inbound-${row.id}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ eventId: row.id, err: message }, "Inbound event failed");
      await withoutTenantScope("worker: record inbound event failure", async (db) => {
        await db.execute(sql`
          update inbound_events
          set attempts = attempts + 1,
              last_error = ${message.slice(0, 500)},
              locked_until = null,
              next_attempt_at = ${now.toISOString()}::timestamptz + make_interval(mins => power(2, attempts)::int),
              state = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'failed'::inbound_event_state else state end
          where id = ${row.id} and clinic_id = ${row.clinic_id}
        `);
        await db.execute(sql`
          update integration_connections set status = 'degraded', last_error = ${message.slice(0, 500)}
          where id = (select connection_id from inbound_events where id = ${row.id})
        `);
      });
    }
  }
  return claimed.length;
}
