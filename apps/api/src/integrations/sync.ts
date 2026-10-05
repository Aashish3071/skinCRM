import { eq, sql } from "drizzle-orm";
import { ConnectorError, type GoogleAdsAccount } from "@skincrm/connectors";
import { schema, withoutTenantScope } from "@skincrm/db";
import { getTx } from "../context";
import { runAsSystem } from "../automations/system-context";
import { secretOf } from "./connections";
import { attachLeadForms, formsSentence } from "./oauth";

/** Discover newly-created Google forms hourly; reserve checks in Postgres across workers. */
export async function syncDueGoogleForms(now = new Date(), limit = 10): Promise<number> {
  const claimed = await withoutTenantScope("worker: claim Google account checks", async (db) => {
    const rows = await db.execute<{ id: string; clinic_id: string }>(sql`
      update integration_connections set last_checked_at = ${now.toISOString()}::timestamptz
      where id in (
        select id from integration_connections
        where provider = 'google_lead_forms' and config->>'via' = 'oauth'
          and (last_checked_at is null or last_checked_at < ${now.toISOString()}::timestamptz - interval '1 hour')
        order by last_checked_at nulls first limit ${limit} for update skip locked
      ) returning id, clinic_id
    `);
    return [...rows];
  });
  for (const row of claimed) {
    await runAsSystem(row.clinic_id, async () => {
      const tx = getTx();
      const connection = (await tx.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, row.id)).limit(1))[0];
      if (!connection) return;
      try {
        const stored = JSON.parse(secretOf(connection) ?? "{}") as { key?: string; refreshToken?: string; account?: GoogleAdsAccount };
        if (!stored.key || !stored.refreshToken || !stored.account) throw new ConnectorError("Reconnect with Google Ads", { retryable: false });
        const result = await attachLeadForms(stored.refreshToken, stored.account, stored.key, true);
        const attention = result.failed.length || result.elsewhere.length;
        await tx.update(schema.integrationConnections).set({ config: { ...connection.config, leadForms: String(result.total - result.failed.length - result.elsewhere.length) }, status: attention ? "degraded" : "healthy", lastError: attention ? formsSentence(result, true).slice(0, 500) : null, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, row.id));
      } catch (error) {
        await tx.update(schema.integrationConnections).set({ status: "error", lastError: (error instanceof Error ? error.message : "Google check failed").slice(0, 500), updatedAt: new Date() }).where(eq(schema.integrationConnections.id, row.id));
      }
    });
  }
  return claimed.length;
}
