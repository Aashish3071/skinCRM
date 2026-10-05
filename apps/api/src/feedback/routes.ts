import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  FEEDBACK_DESTINATIONS,
  FEEDBACK_MILESTONES,
  connectGoogleFeedbackSchema,
  connectMetaCapiSchema,
  feedbackChecklistSchema,
  saveFeedbackSettingsSchema,
  uuidSchema,
  type FeedbackDestinationDto,
  type FeedbackEventDto,
} from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { ConnectorError, getFeedbackConnectors, getOAuthClients } from "@skincrm/connectors";
import { schema } from "@skincrm/db";
import { encryptForClinic } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { registerFeedbackAssetRoutes } from "./assets";
import { getConnection, secretOf } from "../integrations/connections";
import {
  buildPayload,
  cancelQueued,
  deliver,
  destinationRow,
  destinationSecrets,
  feedbackEventId,
  feedbackGate,
  matchKeyFor,
  previewFor,
} from "./service";

const { feedbackDestinations, feedbackEvents, leads, people } = schema;
const destParam = z.object({ destination: z.enum(FEEDBACK_DESTINATIONS) });

function serialize(d: typeof feedbackDestinations.$inferSelect): FeedbackDestinationDto {
  const creds = destinationSecrets(d);
  return {
    destination: d.destination,
    connected: Boolean(d.encryptedSecret),
    accountLabel: d.destination === "meta" ? (d.config.datasetId ?? null) : (d.config.customerId ?? null),
    eligibility: d.eligibility,
    paused: d.paused,
    mapping: d.mapping,
    mappingVersion: d.mappingVersion,
    includeWhatsAppAds: d.includeWhatsAppAds,
    checklistConfirmedBy: d.checklistConfirmedBy,
    checklistConfirmedAt: d.checklistConfirmedAt?.toISOString() ?? null,
    lastTestAt: d.lastTestAt?.toISOString() ?? null,
    lastTestOk: d.lastTestOk,
    lastTestDetail: d.lastTestDetail,
    hasTestEventCode: Boolean(creds?.testEventCode || creds?.whatsappTestEventCode),
    whatsappConnected: Boolean(d.config.whatsappDatasetId && d.config.whatsappBusinessAccountId && (creds?.whatsappAccessToken || creds?.accessToken)),
    whatsappDatasetId: d.config.whatsappDatasetId ?? null,
    whatsappBusinessAccountId: d.config.whatsappBusinessAccountId ?? null,
    whatsappTestOk: d.config.whatsappTestOk === "true" ? true : d.config.whatsappTestOk === "false" ? false : null,
  };
}

async function update(destination: "meta" | "google", values: Partial<typeof feedbackDestinations.$inferInsert>, summary: Record<string, unknown>) {
  const row = await destinationRow(destination);
  const updated = await getTx()
    .update(feedbackDestinations)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(feedbackDestinations.id, row.id))
    .returning();
  await recordAudit({ action: "feedback_mapping_changed", entityType: "feedback_destination", entityId: row.id, changeSummary: { destination, ...summary } });
  return serialize(updated[0]!);
}

async function replaceCredentials(destination: "meta" | "google", config: Record<string, string | null>, credentials: Record<string, unknown>, via = "manual") {
  const row = await destinationRow(destination);
  await cancelQueued(destination, "Conversion credentials changed");
  return update(destination, {
    config, encryptedSecret: encryptForClinic(getContext().clinicId!, JSON.stringify(credentials)),
    eligibility: "unreviewed", lastTestOk: null, mappingVersion: row.mappingVersion + 1,
  }, { credentials: "set", via });
}

export function registerFeedbackRoutes(app: FastifyInstance): void {
  registerFeedbackAssetRoutes(app, update);
  // --- Overview (FB-06, FB-10) ----------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/feedback",
    auth: { capability: "feedback:read" },
    handler: async () => {
      const tx = getTx();
      const dests = await Promise.all(FEEDBACK_DESTINATIONS.map((d) => destinationRow(d)));
      const since = new Date(Date.now() - 28 * 86_400_000);
      const [events, volume] = await Promise.all([
        tx
          .select({ e: feedbackEvents, personName: people.displayName })
          .from(feedbackEvents)
          .innerJoin(leads, eq(leads.id, feedbackEvents.leadId))
          .innerJoin(people, eq(people.id, leads.personId))
          .orderBy(desc(feedbackEvents.createdAt))
          .limit(50),
        tx
          .select({ destination: feedbackEvents.destination, milestone: feedbackEvents.milestone, state: feedbackEvents.state, n: sql<number>`count(*)::int` })
          .from(feedbackEvents)
          .where(gte(feedbackEvents.createdAt, since))
          .groupBy(feedbackEvents.destination, feedbackEvents.milestone, feedbackEvents.state),
      ]);
      return {
        globallyEnabled: getEnv().CONVERSION_FEEDBACK_ENABLED,
        // Name and id only; the refresh token never leaves the server.
        connectedGoogleAds: await connectedGoogleAds().then((a) => (a ? { customerId: a.customerId, name: a.name } : null)),
        modes: { meta: getFeedbackConnectors().meta.mode, whatsapp: getFeedbackConnectors().whatsapp.mode, google: getFeedbackConnectors().google.mode },
        destinations: dests.map(serialize),
        volume,
        events: events.map(({ e, personName }): FeedbackEventDto => ({
          id: e.id,
          destination: e.destination,
          milestone: e.milestone,
          leadId: e.leadId,
          personName,
          state: e.state,
          reason: e.reason,
          testMode: e.testMode,
          attempts: e.attempts,
          eventTime: e.eventTime.toISOString(),
          sentAt: e.sentAt?.toISOString() ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  });

  registerRoute(app, {
    method: "POST", url: "/feedback/events/:id/retry", auth: { capability: "feedback:write" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const event = (await getTx().select().from(feedbackEvents).where(eq(feedbackEvents.id, params.id)).limit(1))[0];
      if (!event || !["rejected", "blocked"].includes(event.state)) throw badRequest("Only rejected or blocked events can be retried.");
      const lead = (await getTx().select().from(leads).where(eq(leads.id, event.leadId)).limit(1))[0];
      if (!lead || lead.isTest) throw badRequest("Test leads cannot be sent to ad accounts.");
      const row = await destinationRow(event.destination);
      // Retrying never retargets an event after an account or mapping change.
      const gate = feedbackGate(row, event, destinationSecrets(row));
      if (!gate.send) throw badRequest(gate.reason);
      await getTx().update(feedbackEvents).set({ state: "queued", attempts: 0, reason: null, nextAttemptAt: new Date(), lockedUntil: null, updatedAt: new Date() }).where(eq(feedbackEvents.id, event.id));
      await recordAudit({ action: "settings_changed", entityType: "feedback_event", entityId: event.id, changeSummary: { retry: true } });
      return { queued: true };
    },
  });

  // --- Mapping (FB-01) --------------------------------------------------------------
  registerRoute(app, {
    method: "PUT",
    url: "/feedback/:destination/settings",
    auth: { capability: "feedback:write" },
    params: destParam,
    body: saveFeedbackSettingsSchema,
    handler: async ({ params, body }) => {
      const row = await destinationRow(params.destination);
      if (params.destination === "google") {
        const connection = await getConnection("google_lead_forms");
        if (connection?.config.via === "oauth" && row.config.googleConnectionId === connection.id) {
          const stored = JSON.parse(secretOf(connection) ?? "{}");
          let actions;
          try { actions = await getOAuthClients().google.listConversionActions(stored.refreshToken, stored.account); }
          catch (error) { if (error instanceof ConnectorError) throw badRequest(error.message); throw error; }
          for (const m of FEEDBACK_MILESTONES) {
            const entry = body.mapping[m];
            if (!entry.enabled) continue;
            const action = actions.find((a) => a.id === entry.conversionActionId && (!entry.conversionCustomerId || a.ownerCustomerId === entry.conversionCustomerId));
            if (!action) throw badRequest("Choose an enabled offline conversion action from the connected Google account.");
            entry.conversionCustomerId = action.ownerCustomerId;
          }
        }
      }
      await cancelQueued(params.destination, "Sync settings changed");
      // Anything no longer mapped must not go out later.
      for (const m of FEEDBACK_MILESTONES) {
        if (row.mapping[m]?.enabled && !body.mapping[m].enabled) {
          await getTx()
            .update(feedbackEvents)
            .set({ state: "canceled", reason: "Milestone unmapped", updatedAt: new Date() })
            .where(and(eq(feedbackEvents.destination, params.destination), eq(feedbackEvents.milestone, m), eq(feedbackEvents.state, "queued")));
        }
      }
      return update(params.destination, { mapping: body.mapping, includeWhatsAppAds: params.destination === "meta" ? body.includeWhatsAppAds : false, mappingVersion: row.mappingVersion + 1, lastTestOk: null, config: { ...row.config, whatsappTestOk: null }, eligibility: row.eligibility === "approved_production" ? "approved_test_only" : row.eligibility }, {
        mappingVersion: row.mappingVersion + 1,
        enabled: FEEDBACK_MILESTONES.filter((m) => body.mapping[m].enabled),
      });
    },
  });

  // --- Credentials (separate from lead ingestion) ------------------------------------
  registerRoute(app, {
    method: "PUT",
    url: "/feedback/meta/credentials",
    auth: { capability: "feedback:write" },
    body: connectMetaCapiSchema,
    handler: async ({ body }) => replaceCredentials("meta", {
      datasetId: body.datasetId, whatsappDatasetId: body.whatsappDatasetId || null, whatsappBusinessAccountId: body.whatsappBusinessAccountId || null,
    }, { accessToken: body.accessToken, testEventCode: body.testEventCode ?? null }),
  });

  registerRoute(app, {
    method: "PUT",
    url: "/feedback/google/credentials",
    auth: { capability: "feedback:write" },
    body: connectGoogleFeedbackSchema,
    handler: async ({ body }) => replaceCredentials("google", { customerId: body.customerId.replace(/-/g, "") }, {
      clientId: body.clientId, clientSecret: body.clientSecret, refreshToken: body.refreshToken, loginCustomerId: body.loginCustomerId ?? null,
    }),
  });

  /**
   * Reuse the account from "Connect with Google Ads" (D-87): the deployment's
   * OAuth client plus the refresh token the clinic already granted, instead of
   * asking an admin to paste a client id, secret and token.
   */
  registerRoute(app, {
    method: "POST",
    url: "/feedback/google/credentials/from-connection",
    auth: { capability: "feedback:write" },
    handler: async () => {
      const found = await connectedGoogleAds();
      if (!found) throw badRequest("Connect with Google Ads first, under Settings → Lead sources & messaging.");
      const env = getEnv();
      const live = env.CONNECTOR_GOOGLE === "live";
      if (live && (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET)) throw badRequest("The server is missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.");
      return replaceCredentials("google", { customerId: found.customerId, googleConnectionId: found.connectionId }, {
        clientId: live ? env.GOOGLE_OAUTH_CLIENT_ID : "mock-client",
        clientSecret: live ? env.GOOGLE_OAUTH_CLIENT_SECRET : "mock-secret",
        refreshToken: found.refreshToken, loginCustomerId: found.loginCustomerId,
      }, "google_connection");
    },
  });

  /** Revoke (FB-07): forget the credentials, cancel what's waiting, back to unreviewed. */
  registerRoute(app, {
    method: "DELETE",
    url: "/feedback/:destination/credentials",
    auth: { capability: "feedback:write" },
    params: destParam,
    handler: async ({ params }) => {
      const canceled = await cancelQueued(params.destination, "Account disconnected");
      const dto = await update(params.destination, { encryptedSecret: null, config: {}, eligibility: "unreviewed", lastTestOk: null }, { credentials: "revoked", canceled });
      await recordAudit({ action: "integration_credentials_revoked", entityType: "feedback_destination", entityId: getContext().clinicId!, changeSummary: { destination: params.destination } });
      return dto;
    },
  });

  // --- Eligibility (FB-03) ----------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/feedback/:destination/checklist",
    auth: { capability: "feedback:write" },
    params: destParam,
    body: feedbackChecklistSchema,
    handler: async ({ params }) => {
      const row = await destinationRow(params.destination);
      if (!FEEDBACK_MILESTONES.some((m) => row.mapping[m]?.enabled)) throw badRequest("Choose at least one milestone to send first.");
      return update(params.destination, { eligibility: "approved_test_only", checklistConfirmedBy: getContext().userId, checklistConfirmedAt: new Date() }, { eligibility: "approved_test_only" });
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/feedback/:destination/blocked",
    auth: { capability: "feedback:write" },
    params: destParam,
    handler: async ({ params }) => {
      await cancelQueued(params.destination, "Marked as not allowed by policy");
      return update(params.destination, { eligibility: "blocked_by_policy" }, { eligibility: "blocked_by_policy" });
    },
  });

  /** Go live: only after the checklist and a successful test (FB-04: test can't silently enable production). */
  registerRoute(app, {
    method: "POST",
    url: "/feedback/:destination/go-live",
    auth: { capability: "feedback:write" },
    params: destParam,
    body: z.object({ confirm: z.literal(true) }),
    handler: async ({ params }) => {
      const row = await destinationRow(params.destination);
      if (row.eligibility !== "approved_test_only") throw badRequest("Complete the checks and a test first.");
      if (row.config.datasetId || params.destination === "google") {
        if (!row.lastTestOk) throw badRequest("Send a successful test event first.");
      }
      if (row.includeWhatsAppAds && row.config.whatsappTestOk !== "true") throw badRequest("Send a successful WhatsApp test event first.");
      if (params.destination === "meta" && !row.config.datasetId && !row.includeWhatsAppAds) throw badRequest("Connect a conversion destination first.");
      return update(params.destination, { eligibility: "approved_production" }, { eligibility: "approved_production" });
    },
  });

  /** Pause / resume everything for one destination (FB-07). */
  registerRoute(app, {
    method: "POST",
    url: "/feedback/:destination/pause",
    auth: { capability: "feedback:write" },
    params: destParam,
    body: z.object({ paused: z.boolean() }),
    handler: async ({ params, body }) => {
      const canceled = body.paused ? await cancelQueued(params.destination, "Paused by an admin") : 0;
      const dto = await update(params.destination, { paused: body.paused }, { paused: body.paused, canceled });
      if (body.paused) await recordAudit({ action: "feedback_paused", entityType: "feedback_destination", entityId: getContext().clinicId!, changeSummary: { destination: params.destination, canceled } });
      return dto;
    },
  });

  // --- Preview and test (FB-04) ------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/feedback/:destination/preview",
    auth: { capability: "feedback:read" },
    params: destParam,
    body: z.object({ leadId: uuidSchema.optional(), channel: z.enum(["meta", "whatsapp", "google"]).optional() }),
    handler: async ({ params, body }) => {
      const row = await destinationRow(params.destination);
      const milestone = FEEDBACK_MILESTONES.find((m) => row.mapping[m]?.enabled);
      if (!milestone) throw badRequest("Map at least one milestone to preview it.");
      const channel = body.channel ?? (params.destination === "google" ? "google" : row.config.datasetId ? "meta" : "whatsapp");
      const matchLead = await matchingLead(row, channel, body.leadId);
      const lead = matchLead ? { id: matchLead.leadId } : null;
      const match = matchLead?.match ?? null;
      const sample = {
        milestone,
        eventId: lead ? feedbackEventId(row.clinicId, lead.id, milestone, row.destination) : "example-event-id",
        eventTime: new Date(),
        matchKey: match?.key ?? (channel === "whatsapp" ? "meta_whatsapp_referral_id" : params.destination === "meta" ? "meta_lead_id" : "google_click_id"),
        matchValue: match?.value ?? (params.destination === "meta" ? "1234567890123456" : "EXAMPLEgclid0000"),
      };
      return { ...previewFor(row, sample, destinationSecrets(row)), basedOn: lead && match ? "your newest matching lead" : "an example — no matching lead yet" };
    },
  });

  /** A synthetic test event in test mode only (Meta test code / Google validate-only). */
  registerRoute(app, {
    method: "POST",
    url: "/feedback/:destination/test",
    body: z.object({ channel: z.enum(["meta", "whatsapp", "google"]).optional(), leadId: uuidSchema.optional() }).optional(),
    auth: { capability: "feedback:write" },
    params: destParam,
    handler: async ({ params, body }) => {
      const row = await destinationRow(params.destination);
      const channel = body?.channel ?? (params.destination === "google" ? "google" : row.config.datasetId ? "meta" : "whatsapp");
      if ((params.destination === "google") !== (channel === "google")) throw badRequest("Choose a channel for this destination.");
      const milestone = FEEDBACK_MILESTONES.find((m) => row.mapping[m]?.enabled);
      if (!milestone) throw badRequest("Map at least one milestone first.");
      const creds = destinationSecrets(row);
      // Always test mode, whatever the destination's state.
      if (row.eligibility !== "approved_test_only" && row.eligibility !== "approved_production") throw badRequest("Complete the review before testing.");
      const testRow = { ...row, eligibility: "approved_test_only" as const };
      const gate = feedbackGate(testRow, { milestone, mappingVersion: row.mappingVersion, matchKey: channel === "whatsapp" ? "meta_whatsapp_referral_id" : channel === "meta" ? "meta_lead_id" : "google_click_id" }, creds);
      let ok = false;
      let detail: string;
      if (!gate.send) {
        detail = gate.reason;
      } else {
        const matching = await matchingLead(row, channel, body?.leadId);
        const mode = channel === "google" ? getFeedbackConnectors().google.mode : channel === "whatsapp" ? getFeedbackConnectors().whatsapp.mode : getFeedbackConnectors().meta.mode;
        if (!matching && mode === "live") throw badRequest("Receive a real ad inquiry for this channel first. A live test must use the ad platform's actual lead or click ID.");
        const event = {
          milestone,
          eventId: `test-${randomUUID()}`,
          eventTime: new Date(),
          matchKey: matching?.match.key ?? (channel === "whatsapp" ? "meta_whatsapp_referral_id" : params.destination === "meta" ? "meta_lead_id" : "google_click_id"),
          matchValue: matching?.match.value ?? (channel === "whatsapp" ? "mock-ctwa-click" : params.destination === "meta" ? "000000000000000" : "TeSt_GcLiD_0000"),
        };
        try {
          detail = (await deliver(testRow, buildPayload(testRow, event, creds, true), creds!)).detail;
          ok = true;
        } catch (error) {
          detail = error instanceof ConnectorError || error instanceof Error ? error.message : "Test failed";
        }
      }
      await getTx().update(feedbackDestinations).set({ lastTestAt: new Date(), ...(channel === "whatsapp" ? { config: { ...row.config, whatsappTestOk: String(ok) } } : { lastTestOk: ok }), lastTestDetail: detail.slice(0, 500) }).where(eq(feedbackDestinations.id, row.id));
      return { ok, detail };
    },
  });
}

/** The ad account connected with "Connect with Google Ads", if any. */
async function connectedGoogleAds() {
  const connection = await getConnection("google_lead_forms");
  if (!connection || connection.config.via !== "oauth") return null;
  const stored = JSON.parse(secretOf(connection) ?? "{}") as { refreshToken?: string; account?: { customerId: string; name: string; loginCustomerId: string | null } };
  if (!stored.refreshToken || !stored.account) return null;
  return { ...stored.account, refreshToken: stored.refreshToken, connectionId: connection.id };
}

async function matchingLead(row: typeof feedbackDestinations.$inferSelect, channel: string, leadId?: string) {
  const expected = channel === "whatsapp" ? "meta_whatsapp_referral_id" : channel === "google" ? "google_click_id" : "meta_lead_id";
  const candidates = await getTx().select({ id: leads.id }).from(leads).innerJoin(schema.sourceSubmissions, or(eq(schema.sourceSubmissions.leadId, leads.id), eq(schema.sourceSubmissions.id, leads.sourceSubmissionId))).where(and(
    leadId ? eq(leads.id, leadId) : undefined,
    eq(schema.sourceSubmissions.platform, channel === "whatsapp" ? "whatsapp" : channel === "meta" ? "meta" : "google"),
    eq(schema.sourceSubmissions.isTest, false),
    channel === "whatsapp" ? eq(schema.sourceSubmissions.source, "whatsapp_ad") : undefined,
  )).orderBy(desc(schema.sourceSubmissions.receivedAt));
  for (const lead of candidates) {
    const match = await matchKeyFor(lead.id, row, new Date(), channel as "meta" | "whatsapp" | "google");
    if (match?.key === expected) return { leadId: lead.id, match };
  }
  return null;
}
