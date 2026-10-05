import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ConnectorError, getAdsClient, type AdCampaign, type AdPlatform } from "@skincrm/connectors";
import { AUDIENCE_SEGMENTS, schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { adContext, availablePlatforms, importLeadHistory, syncAudience, syncSpend } from "./service";

const { integrationConnections, adSpendDaily, adAudiences } = schema;
const platformParam = z.object({ platform: z.enum(["meta", "google"]) });

/** Provider failures become a message the admin can act on. */
async function provider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConnectorError) throw badRequest(error.message);
    throw error;
  }
}

export interface AdvertisingOverview {
  platforms: {
    platform: AdPlatform;
    connected: boolean;
    accountId: string | null;
    needsAccount: boolean;
    error: string | null;
    campaigns: (AdCampaign & { spend30Micros: number; leads30: number; booked30: number; won30: number })[];
  }[];
  audiences: { id: string; platform: AdPlatform; name: string; segment: string; memberCount: number; status: string; lastError: string | null; lastSyncedAt: string | null }[];
  lastSpendSync: string | null;
}

export function registerAdvertisingRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "GET",
    url: "/advertising",
    auth: { capability: "integrations:read" },
    handler: async (): Promise<AdvertisingOverview> => {
      const tx = getTx();
      const connected = new Set(await availablePlatforms());
      // Leads and outcomes per campaign in the last 30 days, by their recorded ad inquiry.
      const outcomes = await tx.execute<{ campaign_id: string; leads: number; booked: number; won: number }>(sql`
        select s.campaign_id, count(distinct l.id)::int as leads,
          count(distinct l.id) filter (where l.booked_at is not null)::int as booked,
          count(distinct l.id) filter (where l.converted_at is not null)::int as won
        from leads l join source_submissions s on s.lead_id = l.id
        where s.campaign_id is not null and l.created_at > now() - interval '30 days' and not l.is_test
        group by 1
      `);
      const byCampaign = new Map([...outcomes].map((o) => [o.campaign_id, o]));
      const spend = await tx.execute<{ campaign_id: string; spend: string }>(sql`
        select campaign_id, sum(spend_micros)::text as spend from ad_spend_daily where day > (now() - interval '30 days')::date group by 1
      `);
      const spendBy = new Map([...spend].map((r) => [r.campaign_id, Number(r.spend)]));

      const platforms: AdvertisingOverview["platforms"] = [];
      for (const platform of ["meta", "google"] as const) {
        if (!connected.has(platform)) {
          platforms.push({ platform, connected: false, accountId: null, needsAccount: false, error: null, campaigns: [] });
          continue;
        }
        const ctx = await adContext(platform, { requireAccount: false });
        if (!ctx.creds.accountId) {
          platforms.push({ platform, connected: true, accountId: null, needsAccount: true, error: null, campaigns: [] });
          continue;
        }
        try {
          const campaigns = await getAdsClient(platform).listCampaigns(ctx.creds);
          platforms.push({
            platform, connected: true, accountId: ctx.creds.accountId, needsAccount: false, error: null,
            campaigns: campaigns.map((c) => ({ ...c, spend30Micros: spendBy.get(c.id) ?? 0, leads30: byCampaign.get(c.id)?.leads ?? 0, booked30: byCampaign.get(c.id)?.booked ?? 0, won30: byCampaign.get(c.id)?.won ?? 0 })),
          });
        } catch (error) {
          platforms.push({ platform, connected: true, accountId: ctx.creds.accountId, needsAccount: false, error: error instanceof Error ? error.message : "Couldn't load campaigns", campaigns: [] });
        }
      }
      const audiences = await tx.select().from(adAudiences).orderBy(desc(adAudiences.createdAt));
      const [last] = await tx.select({ at: sql<Date>`max(${adSpendDaily.updatedAt})` }).from(adSpendDaily);
      return {
        platforms,
        audiences: audiences.map((a) => ({ id: a.id, platform: a.platform, name: a.name, segment: a.segment, memberCount: a.memberCount, status: a.status, lastError: a.lastError, lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null })),
        lastSpendSync: last?.at ? new Date(last.at).toISOString() : null,
      };
    },
  });

  // --- Facebook ad account choice ----------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/advertising/meta/accounts",
    auth: { capability: "integrations:write" },
    handler: async () => {
      const ctx = await adContext("meta", { requireAccount: false });
      return { items: await provider(() => getAdsClient("meta").listAccounts(ctx.creds.accessToken)), selected: ctx.creds.accountId || null };
    },
  });

  registerRoute(app, {
    method: "PUT",
    url: "/advertising/meta/account",
    auth: { capability: "integrations:write" },
    body: z.object({ accountId: z.string().regex(/^act_\d{5,30}$/, "Choose an ad account") }),
    handler: async ({ body }) => {
      const ctx = await adContext("meta", { requireAccount: false });
      const accounts = await provider(() => getAdsClient("meta").listAccounts(ctx.creds.accessToken));
      if (!accounts.some((a) => a.id === body.accountId)) throw badRequest("That ad account isn't available to the connected Facebook login.");
      const [c] = await getTx().select().from(integrationConnections).where(eq(integrationConnections.id, ctx.connectionId));
      await getTx().update(integrationConnections).set({ config: { ...c!.config, adAccountId: body.accountId }, updatedAt: new Date() }).where(eq(integrationConnections.id, ctx.connectionId));
      await recordAudit({ action: "settings_changed", entityType: "integration", entityId: ctx.connectionId, changeSummary: { metaAdAccount: body.accountId } });
      return { ok: true };
    },
  });

  // --- Campaign controls ----------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/advertising/:platform/campaigns/:campaignId/status",
    auth: { capability: "integrations:write" },
    params: platformParam.extend({ campaignId: z.string().regex(/^\d{3,30}$/) }),
    body: z.object({ active: z.boolean() }),
    handler: async ({ params, body }) => {
      const ctx = await adContext(params.platform);
      await provider(() => getAdsClient(params.platform).setCampaignActive(ctx.creds, params.campaignId, body.active));
      await recordAudit({ action: "settings_changed", entityType: "ad_campaign", changeSummary: { platform: params.platform, campaignId: params.campaignId, active: body.active } });
      return { ok: true };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/advertising/:platform/campaigns/:campaignId/budget",
    auth: { capability: "integrations:write" },
    params: platformParam.extend({ campaignId: z.string().regex(/^\d{3,30}$/) }),
    // Whole currency units, as typed. Guard-rails against a slipped digit.
    body: z.object({ dailyBudget: z.coerce.number().min(1, "At least 1 a day").max(10_000, "Change budgets above 10,000 a day in the ad platform itself") }),
    handler: async ({ params, body }) => {
      const ctx = await adContext(params.platform);
      const client = getAdsClient(params.platform);
      const before = (await provider(() => client.listCampaigns(ctx.creds))).find((c) => c.id === params.campaignId);
      if (!before) throw notFound("No such campaign in the connected account.");
      if (before.dailyBudgetMicros === null) throw badRequest("This campaign's budget is set on its ad sets or shared with other campaigns — change it in the ad platform.");
      const micros = Math.round(body.dailyBudget * 100) * 10_000;
      await provider(() => client.setDailyBudget(ctx.creds, params.campaignId, micros));
      await recordAudit({ action: "settings_changed", entityType: "ad_campaign", changeSummary: { platform: params.platform, campaignId: params.campaignId, dailyBudgetFrom: before.dailyBudgetMicros / 1_000_000, dailyBudgetTo: micros / 1_000_000 } });
      return { ok: true };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/advertising/:platform/sync-spend",
    auth: { capability: "integrations:write" },
    params: platformParam,
    handler: async ({ params }) => ({ rows: await provider(() => syncSpend(params.platform, 30)) }),
  });

  // --- History import ------------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/advertising/:platform/import-leads",
    auth: { capability: "integrations:write" },
    params: platformParam,
    body: z.object({ days: z.coerce.number().int().min(1).max(90) }),
    handler: async ({ params, body }) => {
      const result = await provider(() => importLeadHistory(params.platform, body.days));
      await recordAudit({ action: "record_created", entityType: "lead_import", changeSummary: { platform: params.platform, days: body.days, ...result } });
      return result;
    },
  });

  // --- Audiences ----------------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/advertising/audiences",
    auth: { capability: "integrations:write" },
    status: 201,
    body: z.object({ platform: z.enum(["meta", "google"]), segment: z.enum(AUDIENCE_SEGMENTS), name: z.string().trim().min(2).max(120) }),
    handler: async ({ body }) => {
      const ctx = await adContext(body.platform);
      const description = "Kept up to date by SkinCRM. Only people who agreed to marketing from the clinic; hashed contact details.";
      const externalId = await provider(() => getAdsClient(body.platform).createAudience(ctx.creds, body.name, description));
      const [row] = await getTx().insert(adAudiences).values({
        clinicId: getContext().clinicId!, platform: body.platform, externalId, name: body.name, segment: body.segment, createdByUserId: getContext().userId,
      }).returning();
      await recordAudit({ action: "record_created", entityType: "ad_audience", entityId: row!.id, changeSummary: { platform: body.platform, segment: body.segment } });
      const members = await syncAudience(row!.id);
      return { id: row!.id, members };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/advertising/audiences/:id/sync",
    auth: { capability: "integrations:write" },
    params: z.object({ id: z.string().uuid() }),
    handler: async ({ params }) => ({ members: await syncAudience(params.id) }),
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/advertising/audiences/:id",
    auth: { capability: "integrations:write" },
    params: z.object({ id: z.string().uuid() }),
    status: 204,
    handler: async ({ params }) => {
      const [row] = await getTx().select().from(adAudiences).where(eq(adAudiences.id, params.id)).limit(1);
      if (!row) throw notFound("No such audience.");
      const ctx = await adContext(row.platform);
      await provider(() => getAdsClient(row.platform).deleteAudience(ctx.creds, row.externalId));
      await getTx().delete(adAudiences).where(eq(adAudiences.id, row.id));
      await recordAudit({ action: "record_deleted", entityType: "ad_audience", entityId: row.id, changeSummary: { platform: row.platform } });
      return null;
    },
  });
}
