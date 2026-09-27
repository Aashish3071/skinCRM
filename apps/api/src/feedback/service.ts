import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  DEFAULT_FEEDBACK_MAPPING,
  type FeedbackDestination as Destination,
  type FeedbackMilestone,
  type FeedbackPreview,
} from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { ConnectorError, getFeedbackConnectors, type GoogleCredentials } from "@skincrm/connectors";
import { schema, withoutTenantScope } from "@skincrm/db";
import { decryptForClinic } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { logger } from "../logger";
import { runAsSystem } from "../automations/system-context";

const { feedbackDestinations, feedbackEvents, leads, sourceSubmissions } = schema;

const MAX_ATTEMPTS = 5;
type DestinationRow = typeof feedbackDestinations.$inferSelect;
type EventRow = typeof feedbackEvents.$inferSelect;

/** The destination row, created (off, unreviewed) on first use. */
export async function destinationRow(destination: Destination): Promise<DestinationRow> {
  const tx = getTx();
  const found = (await tx.select().from(feedbackDestinations).where(eq(feedbackDestinations.destination, destination)).limit(1))[0];
  if (found) return found;
  const inserted = await tx
    .insert(feedbackDestinations)
    .values({ clinicId: getContext().clinicId!, destination, mapping: DEFAULT_FEEDBACK_MAPPING })
    .onConflictDoNothing()
    .returning();
  return inserted[0] ?? (await tx.select().from(feedbackDestinations).where(eq(feedbackDestinations.destination, destination)).limit(1))[0]!;
}

/** Stable per lead, milestone and destination — retries and replays reuse it (FB-05). */
export function feedbackEventId(clinicId: string, leadId: string, milestone: string, destination: string): string {
  return createHash("sha256").update(`${clinicId}:${leadId}:${milestone}:${destination}`).digest("hex").slice(0, 32);
}

/**
 * The identifier that matches a lead to the platform's ad (FB-02). Only what
 * was captured at intake; never invented, never a name/email/phone.
 */
export async function matchKeyFor(leadId: string, dest: DestinationRow): Promise<{ key: string; value: string } | null> {
  const tx = getTx();
  const row = (
    await tx
      .select({ platform: sourceSubmissions.platform, externalId: sourceSubmissions.externalId, clickId: sourceSubmissions.clickId, referralId: sourceSubmissions.referralId })
      .from(leads)
      .innerJoin(sourceSubmissions, eq(sourceSubmissions.id, leads.sourceSubmissionId))
      .where(eq(leads.id, leadId))
      .limit(1)
  )[0];
  if (!row) return null;
  if (dest.destination === "meta") {
    if (row.platform === "meta" && row.externalId) return { key: "meta_lead_id", value: row.externalId };
    if (dest.includeWhatsAppAds && row.referralId) return { key: "meta_whatsapp_referral_id", value: row.referralId };
    return null;
  }
  if (row.clickId) return { key: "google_click_id", value: row.clickId };
  return null;
}

/**
 * Called when a lead first reaches a milestone (from changeStage). Creates at
 * most one candidate per destination (unique index), and only for
 * destinations that have been reviewed — nothing is queued for an unreviewed
 * destination, so approving one later never back-fills old outcomes.
 */
export async function createFeedbackCandidates(lead: { id: string; isTest: boolean }, milestone: FeedbackMilestone, at: Date): Promise<void> {
  const tx = getTx();
  const clinicId = getContext().clinicId!;
  const dests = await tx.select().from(feedbackDestinations);
  for (const dest of dests) {
    if (dest.paused || !dest.mapping[milestone]?.enabled) continue;
    if (dest.eligibility !== "approved_test_only" && dest.eligibility !== "approved_production") continue;
    const match = await matchKeyFor(lead.id, dest);
    const platform = dest.destination === "meta" ? "Meta" : "Google";
    await tx
      .insert(feedbackEvents)
      .values({
        clinicId,
        destination: dest.destination,
        leadId: lead.id,
        milestone,
        eventId: feedbackEventId(clinicId, lead.id, milestone, dest.destination),
        eventTime: at,
        matchKey: match?.key ?? null,
        matchValue: match?.value ?? null,
        mappingVersion: dest.mappingVersion,
        state: lead.isTest ? "blocked" : match ? "queued" : "unmatched",
        reason: lead.isTest ? "Test lead — never sent" : match ? null : `This lead didn't come from a ${platform} ad, so there is nothing to match it to`,
      })
      .onConflictDoNothing({ target: [feedbackEvents.clinicId, feedbackEvents.destination, feedbackEvents.leadId, feedbackEvents.milestone] });
  }
}

/** Cancel everything still waiting for a destination (FB-07: pause/revoke). */
export async function cancelQueued(destination: Destination, reason: string): Promise<number> {
  const rows = await getTx()
    .update(feedbackEvents)
    .set({ state: "canceled", reason, updatedAt: new Date() })
    .where(and(eq(feedbackEvents.destination, destination), eq(feedbackEvents.state, "queued")))
    .returning({ id: feedbackEvents.id });
  return rows.length;
}

// --- Sending -------------------------------------------------------------------

type Secrets = { accessToken?: string; testEventCode?: string | null } & Partial<GoogleCredentials>;

function secrets(dest: DestinationRow): Secrets | null {
  return dest.encryptedSecret ? (JSON.parse(decryptForClinic(dest.clinicId, dest.encryptedSecret)) as Secrets) : null;
}

type Gate = { send: true; testMode: boolean } | { send: false; state: "blocked" | "canceled"; reason: string };

/** Everything that must be true, checked at the moment of sending (FB-03, FB-07). */
export function feedbackGate(dest: DestinationRow, event: Pick<EventRow, "milestone" | "mappingVersion">, creds: Secrets | null): Gate {
  if (!getEnv().CONVERSION_FEEDBACK_ENABLED) return { send: false, state: "blocked", reason: "Conversion feedback is switched off for this installation (CONVERSION_FEEDBACK_ENABLED)" };
  if (dest.paused) return { send: false, state: "canceled", reason: "Paused by an admin" };
  if (!dest.mapping[event.milestone]?.enabled) return { send: false, state: "canceled", reason: "This milestone is no longer mapped" };
  if (dest.eligibility === "blocked_by_policy") return { send: false, state: "blocked", reason: "Marked as not allowed by the platform's policy" };
  if (dest.eligibility !== "approved_test_only" && dest.eligibility !== "approved_production") {
    return { send: false, state: "blocked", reason: "Not reviewed yet" };
  }
  if (!creds) return { send: false, state: "blocked", reason: "Not connected" };
  const testMode = dest.eligibility === "approved_test_only";
  if (testMode && dest.destination === "meta" && !creds.testEventCode) {
    return { send: false, state: "blocked", reason: "Test mode needs a Meta test event code" };
  }
  if (dest.destination === "google" && !dest.mapping[event.milestone]?.conversionActionId) {
    return { send: false, state: "blocked", reason: "No Google conversion action chosen for this milestone" };
  }
  return { send: true, testMode };
}

/**
 * The payload, built from an allowlist (FB-03): event name, time, stable id,
 * one match identifier. There is no code path that adds anything else.
 */
export function buildPayload(dest: DestinationRow, event: Pick<EventRow, "milestone" | "eventId" | "eventTime" | "matchKey" | "matchValue">, creds: Secrets | null, testMode: boolean) {
  const entry = dest.mapping[event.milestone];
  if (dest.destination === "meta") {
    return {
      eventName: entry.eventName,
      eventTime: event.eventTime,
      eventId: event.eventId,
      leadId: event.matchKey === "meta_lead_id" ? event.matchValue : null,
      whatsappReferralId: event.matchKey === "meta_whatsapp_referral_id" ? event.matchValue : null,
      testEventCode: testMode ? (creds?.testEventCode ?? null) : null,
    };
  }
  return {
    conversionActionId: entry.conversionActionId,
    gclid: event.matchValue ?? "",
    eventTime: event.eventTime,
    eventId: event.eventId,
    validateOnly: testMode,
  };
}

const mask = (v: string | null) => (v ? `${v.slice(0, 4)}${"•".repeat(Math.max(3, Math.min(8, v.length - 4)))}` : "—");

/** What would be sent, identifiers masked (FB-04). Sends nothing. */
export function previewFor(dest: DestinationRow, event: Pick<EventRow, "milestone" | "eventId" | "eventTime" | "matchKey" | "matchValue">, creds: Secrets | null): FeedbackPreview {
  const testMode = dest.eligibility !== "approved_production";
  const p = buildPayload(dest, event, creds, testMode) as Record<string, unknown>;
  const masked = { ...p, ...(p.leadId ? { leadId: mask(p.leadId as string) } : {}), ...(p.whatsappReferralId ? { whatsappReferralId: mask(p.whatsappReferralId as string) } : {}), ...(p.gclid ? { gclid: mask(p.gclid as string) } : {}), ...(p.testEventCode ? { testEventCode: "set" } : {}) };
  return {
    destination: dest.destination,
    milestone: event.milestone,
    eventName: dest.mapping[event.milestone].eventName,
    eventTime: event.eventTime.toISOString(),
    eventId: event.eventId,
    identifiers: event.matchKey ? { [event.matchKey]: mask(event.matchValue) } : {},
    payload: masked,
    mode: testMode ? "test" : "production",
  };
}

/** Send one payload through the right adapter. */
export async function deliver(dest: DestinationRow, payload: ReturnType<typeof buildPayload>, creds: Secrets): Promise<string> {
  const { meta, google } = getFeedbackConnectors();
  if (dest.destination === "meta") {
    const p = payload as Extract<ReturnType<typeof buildPayload>, { eventName: string }>;
    const r = await meta.send({
      datasetId: dest.config.datasetId ?? "",
      accessToken: creds.accessToken ?? "",
      testEventCode: p.testEventCode,
      events: [{ eventName: p.eventName, eventTime: p.eventTime, eventId: p.eventId, leadId: p.leadId, whatsappReferralId: p.whatsappReferralId }],
    });
    if (r.accepted < 1) throw new ConnectorError("Meta received the request but accepted no events", { retryable: false });
    return `Accepted by Meta${r.traceId ? ` (trace ${r.traceId})` : ""}`;
  }
  const p = payload as Extract<ReturnType<typeof buildPayload>, { gclid: string }>;
  const r = await google.send({
    credentials: { customerId: dest.config.customerId ?? "", clientId: creds.clientId ?? "", clientSecret: creds.clientSecret ?? "", refreshToken: creds.refreshToken ?? "", loginCustomerId: creds.loginCustomerId ?? null },
    conversions: [{ conversionActionId: p.conversionActionId, gclid: p.gclid, eventTime: p.eventTime, eventId: p.eventId }],
    validateOnly: p.validateOnly,
  });
  return `Accepted by Google${p.validateOnly ? " (validate-only test)" : ""}${r.requestId ? ` (request ${r.requestId})` : ""}`;
}

async function processOne(eventId: string): Promise<void> {
  const tx = getTx();
  const event = (await tx.select().from(feedbackEvents).where(eq(feedbackEvents.id, eventId)).limit(1))[0];
  if (!event || event.state !== "queued") return;
  const dest = (await tx.select().from(feedbackDestinations).where(eq(feedbackDestinations.destination, event.destination)).limit(1))[0];
  const creds = dest ? secrets(dest) : null;
  const gate = dest ? feedbackGate(dest, event, creds) : ({ send: false, state: "canceled", reason: "Destination removed" } as const);
  if (!gate.send) {
    await tx.update(feedbackEvents).set({ state: gate.state, reason: gate.reason, lockedUntil: null, updatedAt: new Date() }).where(eq(feedbackEvents.id, event.id));
    return;
  }
  await tx.update(feedbackEvents).set({ state: "sending", testMode: gate.testMode, attempts: event.attempts + 1 }).where(eq(feedbackEvents.id, event.id));
  try {
    const detail = await deliver(dest!, buildPayload(dest!, event, creds, gate.testMode), creds!);
    await tx.update(feedbackEvents).set({ state: "accepted", providerResponse: detail.slice(0, 500), reason: null, sentAt: new Date(), lockedUntil: null, updatedAt: new Date() }).where(eq(feedbackEvents.id, event.id));
  } catch (error) {
    const retryable = error instanceof ConnectorError ? error.options.retryable : true;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const giveUp = !retryable || event.attempts + 1 >= MAX_ATTEMPTS;
    await tx
      .update(feedbackEvents)
      .set({
        state: giveUp ? "rejected" : "queued",
        reason: message,
        providerResponse: message,
        nextAttemptAt: new Date(Date.now() + 2 ** (event.attempts + 1) * 60_000),
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(feedbackEvents.id, event.id));
  }
}

/** Worker job: claim due outbox rows across clinics, process each in its clinic. */
export async function processFeedbackOutbox(limit = 25, now = new Date()): Promise<number> {
  const claimed = await withoutTenantScope("worker: claim due conversion feedback across clinics", async (db) => {
    const rows = await db.execute<{ id: string; clinic_id: string }>(sql`
      update feedback_events set locked_until = ${now.toISOString()}::timestamptz + interval '2 minutes'
      where id in (
        select id from feedback_events
        where state = 'queued' and next_attempt_at <= ${now.toISOString()}::timestamptz
          and (locked_until is null or locked_until < ${now.toISOString()}::timestamptz)
        order by next_attempt_at limit ${limit}
        for update skip locked
      )
      returning id, clinic_id
    `);
    return [...rows];
  });
  for (const row of claimed) {
    try {
      await runAsSystem(row.clinic_id, () => processOne(row.id), { correlationId: `feedback-${row.id}` });
    } catch (error) {
      logger.warn({ eventId: row.id, err: error instanceof Error ? error.message : String(error) }, "Feedback event failed");
    }
  }
  return claimed.length;
}

export { secrets as destinationSecrets };
