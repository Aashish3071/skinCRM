import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ConnectorError, getAdsClient, type GoogleAdsClient, type MetaAdsClient, type MockAdsClient, type AdCredentials, type AdPlatform, type AudienceMember } from "@skincrm/connectors";
import { schema, withoutTenantScope } from "@skincrm/db";
import type { AudienceSegment } from "@skincrm/db";
import { decryptForClinic } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest } from "../errors";
import { logger } from "../logger";
import { runAsSystem } from "../automations/system-context";
import { enqueueEvent } from "../integrations/processor";

/**
 * Ad account management (D-95): spend sync, campaign controls, customer-list
 * audiences and history import, using the credentials from Connect with
 * Facebook (its long-lived user token, ads_management) and Connect with Google
 * Ads (its refresh token and customer).
 */
const { integrationConnections, adSpendDaily, adAudiences } = schema;

export interface AdContext {
  platform: AdPlatform;
  creds: AdCredentials;
  connectionId: string;
  /** Meta only: the Page, for lead history. */
  pageId?: string;
  pageToken?: string;
}

/** Credentials for one platform, or a message saying what to connect. */
export async function adContext(platform: AdPlatform, opts: { requireAccount?: boolean } = {}): Promise<AdContext> {
  const tx = getTx();
  if (platform === "meta") {
    const [c] = await tx.select().from(integrationConnections).where(eq(integrationConnections.provider, "meta_lead_ads")).limit(1);
    if (!c) throw badRequest("Connect with Facebook first (Lead sources & messaging).");
    if (!c.config.adTokenSealed) throw badRequest("Reconnect with Facebook to let SkinCRM manage ads — the current connection only reads leads.");
    const accessToken = decryptForClinic(c.clinicId, c.config.adTokenSealed);
    const accountId = c.config.adAccountId ?? "";
    if (opts.requireAccount !== false && !accountId) throw badRequest("Choose which Facebook ad account to use on the Advertising page.");
    return { platform, creds: { accessToken, accountId }, connectionId: c.id, pageId: c.externalAccountId, pageToken: c.encryptedSecret ? decryptForClinic(c.clinicId, c.encryptedSecret) : undefined };
  }
  const [c] = await tx.select().from(integrationConnections).where(eq(integrationConnections.provider, "google_lead_forms")).limit(1);
  if (!c || c.config.via !== "oauth" || !c.encryptedSecret) throw badRequest("Connect with Google Ads first (Lead sources & messaging).");
  const stored = JSON.parse(decryptForClinic(c.clinicId, c.encryptedSecret)) as { refreshToken?: string; account?: { customerId: string; loginCustomerId: string | null } };
  if (!stored.refreshToken || !stored.account) throw badRequest("Reconnect with Google Ads.");
  return { platform, creds: { accessToken: stored.refreshToken, accountId: stored.account.customerId, loginCustomerId: stored.account.loginCustomerId }, connectionId: c.id };
}

export async function availablePlatforms(): Promise<AdPlatform[]> {
  const out: AdPlatform[] = [];
  for (const p of ["meta", "google"] as const) {
    try {
      await adContext(p, { requireAccount: false });
      out.push(p);
    } catch {
      // Not connected.
    }
  }
  return out;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Copy the last `days` of per-campaign spend into ad_spend_daily (upsert). */
export async function syncSpend(platform: AdPlatform, days = 30): Promise<number> {
  const ctx = await adContext(platform);
  const client = getAdsClient(platform);
  const to = new Date();
  const from = new Date(Date.now() - days * 86_400_000);
  const [rows, campaigns] = await Promise.all([client.dailySpend(ctx.creds, day(from), day(to)), client.listCampaigns(ctx.creds)]);
  const currency = campaigns[0]?.currency ?? "USD";
  const tx = getTx();
  for (const r of rows) {
    await tx.insert(adSpendDaily).values({
      clinicId: getContext().clinicId!, platform, campaignId: r.campaignId, campaignName: r.campaignName, day: r.date,
      spendMicros: r.spendMicros, impressions: r.impressions, clicks: r.clicks, currency,
    }).onConflictDoUpdate({
      target: [adSpendDaily.clinicId, adSpendDaily.platform, adSpendDaily.campaignId, adSpendDaily.day],
      set: { campaignName: r.campaignName, spendMicros: r.spendMicros, impressions: r.impressions, clicks: r.clicks, currency, updatedAt: new Date() },
    });
  }
  return rows.length;
}

// --- Audiences -------------------------------------------------------------------

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * People in a segment who agreed to marketing on that channel — email only if
 * their latest promotional email consent is granted and the address isn't
 * suppressed; phone likewise for WhatsApp/SMS. Hashed per platform rules:
 * Meta wants phone digits without "+", Google wants E.164 with "+".
 */
export async function audienceMembers(segment: AudienceSegment, platform: AdPlatform): Promise<AudienceMember[]> {
  const segmentFilter = {
    marketing_consented: sql`true`,
    won: sql`exists (select 1 from leads l where l.person_id = p.id and l.converted_at is not null)`,
    booked_not_won: sql`exists (select 1 from leads l where l.person_id = p.id and l.booked_at is not null)
      and not exists (select 1 from leads l where l.person_id = p.id and l.converted_at is not null)`,
    leads_not_booked: sql`exists (select 1 from leads l where l.person_id = p.id and l.booked_at is null and l.closed_at is null and l.archived_at is null)`,
  }[segment];
  const rows = await getTx().execute<{ email: string | null; phone: string | null; email_ok: boolean; phone_ok: boolean }>(sql`
    with latest as (
      select distinct on (person_id, channel) person_id, channel, status
      from consent_records where purpose = 'promotional'
      order by person_id, channel, occurred_at desc
    )
    select p.email_normalized as email, p.phone_e164 as phone,
      bool_or(l.channel = 'email' and l.status = 'granted') as email_ok,
      bool_or(l.channel in ('whatsapp', 'sms') and l.status = 'granted') as phone_ok
    from people p join latest l on l.person_id = p.id
    where p.archived_at is null and ${segmentFilter}
    group by p.id
  `);
  const suppressed = await getTx().execute<{ channel: string; destination: string }>(sql`
    select channel::text, destination from suppressions where expires_at is null or expires_at > now()
  `);
  const blocked = new Set([...suppressed].map((s) => `${s.channel}:${s.destination}`));
  const members: AudienceMember[] = [];
  for (const r of rows) {
    const email = r.email_ok && r.email && !blocked.has(`email:${r.email}`) ? r.email.trim().toLowerCase() : null;
    const digits = r.phone?.replace(/\D/g, "") ?? null;
    const phone = r.phone_ok && digits && !blocked.has(`whatsapp:${digits}`) && !blocked.has(`sms:${r.phone}`) ? digits : null;
    if (!email && !phone) continue;
    members.push({
      emailSha256: email ? sha(email) : null,
      phoneSha256: phone ? sha(platform === "google" ? `+${phone}` : phone) : null,
    });
  }
  return members;
}

export async function syncAudience(audienceId: string): Promise<number> {
  const tx = getTx();
  const [row] = await tx.select().from(adAudiences).where(eq(adAudiences.id, audienceId)).limit(1);
  if (!row) throw badRequest("No such audience.");
  try {
    const ctx = await adContext(row.platform);
    const members = await audienceMembers(row.segment, row.platform);
    await getAdsClient(row.platform).replaceAudience(ctx.creds, row.externalId, members);
    await tx.update(adAudiences).set({ memberCount: members.length, status: "healthy", lastError: null, lastSyncedAt: new Date() }).where(eq(adAudiences.id, row.id));
    return members.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    await tx.update(adAudiences).set({ status: "error", lastError: message.slice(0, 500), lastSyncedAt: new Date() }).where(eq(adAudiences.id, row.id));
    if (error instanceof ConnectorError) return 0;
    throw error;
  }
}

// --- History import ----------------------------------------------------------------

/**
 * Pull past lead-form submissions (up to 90 days) through the normal intake
 * queue as historical: original dates kept, no automations or alerts. Leads we
 * already have are skipped by the queue's (type, external id) key.
 */
export async function importLeadHistory(platform: AdPlatform, days: number): Promise<{ queued: number; alreadyHad: number }> {
  const ctx = await adContext(platform, { requireAccount: platform === "google" });
  const since = new Date(Date.now() - days * 86_400_000);
  const client = getAdsClient(platform);
  let queued = 0;
  let alreadyHad = 0;
  if (platform === "meta") {
    if (!ctx.pageId || !ctx.pageToken) throw badRequest("Reconnect with Facebook.");
    const leads = await (client as MetaAdsClient | MockAdsClient).pageLeadsSince(ctx.pageId, ctx.pageToken, since);
    for (const l of leads) {
      const fresh = await enqueueEvent({ connectionId: ctx.connectionId, type: "meta_leadgen", externalId: l.externalId, payload: { leadgen_id: l.externalId, page_id: ctx.pageId, form_id: l.formId, historical: true } });
      if (fresh) queued += 1; else alreadyHad += 1;
    }
  } else {
    const leads = await (client as GoogleAdsClient | MockAdsClient).leadsSince(ctx.creds, since);
    // A lead that arrived by webhook has a different id; its click id gives it away.
    const known = new Set([...(await getTx().execute<{ click_id: string }>(sql`select click_id from source_submissions where platform = 'google' and click_id is not null`))].map((r) => r.click_id));
    for (const l of leads) {
      if (l.gclid && known.has(l.gclid)) { alreadyHad += 1; continue; }
      const fresh = await enqueueEvent({ connectionId: ctx.connectionId, type: "google_lead", externalId: `history-${l.externalId}`, payload: {
        lead_id: `history-${l.externalId}`, form_id: l.formId, campaign_id: l.campaignId, gcl_id: l.gclid,
        user_column_data: l.fields.map((f) => ({ column_id: f.columnId, string_value: f.value })),
        submitted_at: l.submittedAt.toISOString(), historical: true,
      } });
      if (fresh) queued += 1; else alreadyHad += 1;
    }
  }
  return { queued, alreadyHad };
}

// --- Worker -------------------------------------------------------------------------

/** Hourly: spend for every clinic with a connected ad account; daily: audiences. */
export async function syncAdvertisingForAllClinics(opts: { audiences: boolean }): Promise<void> {
  const clinics = await withoutTenantScope("advertising: clinics with ad connections", (db) =>
    db.selectDistinct({ clinicId: integrationConnections.clinicId }).from(integrationConnections)
      .where(sql`${integrationConnections.provider} in ('meta_lead_ads', 'google_lead_forms')`),
  );
  for (const { clinicId } of clinics) {
    try {
      await runAsSystem(clinicId, async () => {
        for (const platform of await availablePlatforms()) {
          try {
            await syncSpend(platform, 30);
          } catch (error) {
            logger.warn({ clinicId, platform, err: error instanceof Error ? error.message : String(error) }, "Ad spend sync skipped");
          }
        }
        if (opts.audiences) {
          const audiences = await getTx().select({ id: adAudiences.id }).from(adAudiences);
          for (const a of audiences) await syncAudience(a.id);
        }
      });
    } catch (error) {
      logger.error({ clinicId, err: error instanceof Error ? error.message : String(error) }, "Advertising sync failed");
    }
  }
}
