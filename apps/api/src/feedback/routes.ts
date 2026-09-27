import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
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
import { ConnectorError, getFeedbackConnectors } from "@skincrm/connectors";
import { schema } from "@skincrm/db";
import { encryptForClinic } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
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
    hasTestEventCode: Boolean(creds?.testEventCode),
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

export function registerFeedbackRoutes(app: FastifyInstance): void {
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
        modes: { meta: getFeedbackConnectors().meta.mode, google: getFeedbackConnectors().google.mode },
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

  // --- Mapping (FB-01) --------------------------------------------------------------
  registerRoute(app, {
    method: "PUT",
    url: "/feedback/:destination/settings",
    auth: { capability: "feedback:write" },
    params: destParam,
    body: saveFeedbackSettingsSchema,
    handler: async ({ params, body }) => {
      const row = await destinationRow(params.destination);
      // Anything no longer mapped must not go out later.
      for (const m of FEEDBACK_MILESTONES) {
        if (row.mapping[m]?.enabled && !body.mapping[m].enabled) {
          await getTx()
            .update(feedbackEvents)
            .set({ state: "canceled", reason: "Milestone unmapped", updatedAt: new Date() })
            .where(and(eq(feedbackEvents.destination, params.destination), eq(feedbackEvents.milestone, m), eq(feedbackEvents.state, "queued")));
        }
      }
      return update(params.destination, { mapping: body.mapping, includeWhatsAppAds: params.destination === "meta" ? body.includeWhatsAppAds : false, mappingVersion: row.mappingVersion + 1 }, {
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
    handler: async ({ body }) =>
      update("meta", {
        config: { datasetId: body.datasetId },
        encryptedSecret: encryptForClinic(getContext().clinicId!, JSON.stringify({ accessToken: body.accessToken, testEventCode: body.testEventCode ?? null })),
        lastTestOk: null,
      }, { credentials: "set" }),
  });

  registerRoute(app, {
    method: "PUT",
    url: "/feedback/google/credentials",
    auth: { capability: "feedback:write" },
    body: connectGoogleFeedbackSchema,
    handler: async ({ body }) =>
      update("google", {
        config: { customerId: body.customerId },
        encryptedSecret: encryptForClinic(getContext().clinicId!, JSON.stringify({ clientId: body.clientId, clientSecret: body.clientSecret, refreshToken: body.refreshToken, loginCustomerId: body.loginCustomerId ?? null })),
        lastTestOk: null,
      }, { credentials: "set" }),
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
      if (!row.lastTestOk) throw badRequest("Send a successful test event first.");
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
    body: z.object({ leadId: uuidSchema.optional() }),
    handler: async ({ params, body }) => {
      const row = await destinationRow(params.destination);
      const milestone = FEEDBACK_MILESTONES.find((m) => row.mapping[m]?.enabled);
      if (!milestone) throw badRequest("Map at least one milestone to preview it.");
      const tx = getTx();
      let lead: { id: string } | undefined;
      if (body.leadId) lead = (await tx.select({ id: leads.id }).from(leads).where(eq(leads.id, body.leadId)).limit(1))[0];
      if (!lead) {
        // The newest lead that came from this platform, so the preview shows a real match.
        const platform = params.destination === "meta" ? "meta" : "google";
        lead = (
          await tx
            .select({ id: leads.id })
            .from(leads)
            .innerJoin(schema.sourceSubmissions, eq(schema.sourceSubmissions.id, leads.sourceSubmissionId))
            .where(and(eq(schema.sourceSubmissions.platform, platform), isNotNull(leads.sourceSubmissionId)))
            .orderBy(desc(leads.createdAt))
            .limit(1)
        )[0];
      }
      const match = lead ? await matchKeyFor(lead.id, row) : null;
      const sample = {
        milestone,
        eventId: lead ? feedbackEventId(row.clinicId, lead.id, milestone, row.destination) : "example-event-id",
        eventTime: new Date(),
        matchKey: match?.key ?? (params.destination === "meta" ? "meta_lead_id" : "google_click_id"),
        matchValue: match?.value ?? (params.destination === "meta" ? "1234567890123456" : "EXAMPLEgclid0000"),
      };
      return { ...previewFor(row, sample, destinationSecrets(row)), basedOn: lead && match ? "your newest matching lead" : "an example — no matching lead yet" };
    },
  });

  /** A synthetic test event in test mode only (Meta test code / Google validate-only). */
  registerRoute(app, {
    method: "POST",
    url: "/feedback/:destination/test",
    auth: { capability: "feedback:write" },
    params: destParam,
    handler: async ({ params }) => {
      const row = await destinationRow(params.destination);
      const milestone = FEEDBACK_MILESTONES.find((m) => row.mapping[m]?.enabled);
      if (!milestone) throw badRequest("Map at least one milestone first.");
      const creds = destinationSecrets(row);
      // Always test mode, whatever the destination's state.
      const testRow = { ...row, eligibility: "approved_test_only" as const };
      const gate = feedbackGate(testRow, { milestone, mappingVersion: row.mappingVersion }, creds);
      let ok = false;
      let detail: string;
      if (!gate.send) {
        detail = gate.reason;
      } else {
        const event = {
          milestone,
          eventId: `test-${randomUUID()}`,
          eventTime: new Date(),
          matchKey: params.destination === "meta" ? "meta_lead_id" : "google_click_id",
          matchValue: params.destination === "meta" ? "000000000000000" : "TeSt_GcLiD_0000",
        };
        try {
          detail = await deliver(testRow, buildPayload(testRow, event, creds, true), creds!);
          ok = true;
        } catch (error) {
          detail = error instanceof ConnectorError || error instanceof Error ? error.message : "Test failed";
        }
      }
      await getTx().update(feedbackDestinations).set({ lastTestAt: new Date(), lastTestOk: ok, lastTestDetail: detail.slice(0, 500) }).where(eq(feedbackDestinations.id, row.id));
      return { ok, detail };
    },
  });
}
