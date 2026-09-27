import { sql } from "drizzle-orm";
import { getEnv } from "@skincrm/config";
import { schema, withoutTenantScope } from "@skincrm/db";
import { logger } from "../logger";
import { sendSystemEmail } from "../messaging/system-email";

const { opsHeartbeats } = schema;

/**
 * Operations monitoring (PRD 9 "Observability"): the conditions the PRD says
 * must alert — webhook errors, no events from an active source, queue backlog,
 * email failures, backup failures — plus a stalled worker.
 *
 * Everything here reads across clinics with the owner connection and returns
 * counts and clinic *names* only, never personal data, because alerts go to an
 * operations mailbox.
 */

export interface OpsAlert {
  key: string;
  severity: "critical" | "warning";
  message: string;
}

export async function heartbeat(key: string, detail?: string): Promise<void> {
  await withoutTenantScope("ops: record heartbeat", (db) =>
    db
      .insert(opsHeartbeats)
      .values({ key, at: new Date(), detail: detail ?? null })
      .onConflictDoUpdate({ target: opsHeartbeats.key, set: { at: new Date(), detail: detail ?? null } }),
  );
}

export async function lastBeat(key: string): Promise<Date | null> {
  const rows = await withoutTenantScope("ops: read heartbeat", (db) =>
    db.execute<{ at: Date }>(sql`select at from ops_heartbeats where key = ${key}`),
  );
  const at = [...rows][0]?.at;
  return at ? new Date(at) : null;
}

export async function collectAlerts(now = new Date()): Promise<OpsAlert[]> {
  const env = getEnv();
  const alerts: OpsAlert[] = [];
  const iso = now.toISOString();

  const worker = await lastBeat("worker");
  if (!worker || now.getTime() - worker.getTime() > 3 * 60_000) {
    alerts.push({ key: "worker_down", severity: "critical", message: `The background worker has not reported since ${worker?.toISOString() ?? "it was installed"}. Automations, ad leads and WhatsApp messages are not being processed.` });
  }

  const rows = await withoutTenantScope("ops: collect alert counts across clinics", (db) =>
    db.execute<{ kind: string; clinic: string; n: number }>(sql`
      select 'inbound_backlog' as kind, c.name as clinic, count(*)::int as n
        from inbound_events e join clinics c on c.id = e.clinic_id
        where e.state = 'pending' and e.received_at < ${iso}::timestamptz - interval '10 minutes'
        group by c.name
      union all
      select 'inbound_failed', c.name, count(*)::int
        from inbound_events e join clinics c on c.id = e.clinic_id
        where e.state = 'failed' and e.received_at > ${iso}::timestamptz - interval '24 hours'
        group by c.name
      union all
      select 'automation_backlog', c.name, count(*)::int
        from automation_enrollments a join clinics c on c.id = a.clinic_id
        where a.state = 'active' and a.next_run_at < ${iso}::timestamptz - interval '10 minutes'
        group by c.name
      union all
      select 'integration_error', c.name, count(*)::int
        from integration_connections i join clinics c on c.id = i.clinic_id
        where i.status in ('error', 'degraded')
        group by c.name
      union all
      select 'source_silent', c.name, count(*)::int
        from integration_connections i join clinics c on c.id = i.clinic_id
        where i.provider in ('meta_lead_ads', 'google_lead_forms') and i.status = 'healthy'
          and coalesce(i.last_event_at, i.created_at) < ${iso}::timestamptz - interval '7 days'
        group by c.name
      union all
      select 'feedback_rejected', c.name, count(*)::int
        from feedback_events f join clinics c on c.id = f.clinic_id
        where f.state = 'rejected' and f.updated_at > ${iso}::timestamptz - interval '24 hours'
        group by c.name
      union all
      select 'email_failures', c.name, count(*)::int
        from messages m join clinics c on c.id = m.clinic_id
        where m.channel = 'email' and m.state in ('failed', 'bounced')
          and m.created_at > ${iso}::timestamptz - interval '1 hour'
        group by c.name having count(*) >= 3
    `),
  );

  const text: Record<string, [OpsAlert["severity"], (clinic: string, n: number) => string]> = {
    inbound_backlog: ["critical", (c, n) => `${c}: ${n} incoming lead/WhatsApp events waiting more than 10 minutes.`],
    inbound_failed: ["critical", (c, n) => `${c}: ${n} incoming events failed permanently in the last 24 hours (Settings → Lead sources shows why).`],
    automation_backlog: ["warning", (c, n) => `${c}: ${n} automation runs overdue by more than 10 minutes.`],
    integration_error: ["critical", (c, n) => `${c}: ${n} connected account(s) reporting errors.`],
    source_silent: ["warning", (c, n) => `${c}: ${n} connected ad account(s) have sent no leads for 7 days — check the connection.`],
    feedback_rejected: ["warning", (c, n) => `${c}: ${n} conversion events rejected by an ad platform in the last 24 hours (Settings → Ad platform feedback).`],
    email_failures: ["warning", (c, n) => `${c}: ${n} emails failed or bounced in the last hour.`],
  };
  for (const r of rows) {
    const [severity, fmt] = text[r.kind]!;
    alerts.push({ key: `${r.kind}:${r.clinic}`, severity, message: fmt(r.clinic, r.n) });
  }

  if (env.BACKUPS_EXPECTED) {
    const backup = await lastBeat("backup");
    if (!backup || now.getTime() - backup.getTime() > 26 * 3600_000) {
      alerts.push({ key: "backup_missing", severity: "critical", message: `No successful backup since ${backup?.toISOString() ?? "never"}.` });
    }
  }
  return alerts;
}

/** Email new or still-open alerts at most once an hour each. */
export async function runMonitor(now = new Date()): Promise<OpsAlert[]> {
  const alerts = await collectAlerts(now);
  const to = getEnv().OPS_ALERT_EMAIL;
  for (const alert of alerts) {
    logger.warn({ alert: alert.key, severity: alert.severity }, alert.message);
    if (!to) continue;
    const last = await lastBeat(`alert:${alert.key}`);
    if (last && now.getTime() - last.getTime() < 3600_000) continue;
    await sendSystemEmail({ to, subject: `[SkinCRM ${alert.severity}] ${alert.message.slice(0, 80)}`, text: alert.message });
    await heartbeat(`alert:${alert.key}`, alert.message);
  }
  return alerts;
}

/**
 * Retention (PRD 8): raw provider payloads are kept for replay and disputes,
 * then deleted; processed inbound events after 90 days. Leads, people and
 * their history are never touched here — deletion of personal records is a
 * deliberate admin workflow, not a timer.
 */
export async function applyRetention(now = new Date()): Promise<{ rawPayloads: number; inboundEvents: number }> {
  const days = getEnv().RAW_PAYLOAD_RETENTION_DAYS;
  return withoutTenantScope("ops: retention across clinics", async (db) => {
    await db.execute(sql`
      update source_submissions set raw_payload_id = null
      where raw_payload_id in (select id from raw_payloads where coalesce(retention_until, received_at + make_interval(days => ${days})) < ${now.toISOString()}::timestamptz)
    `);
    const raw = await db.execute(sql`
      delete from raw_payloads where coalesce(retention_until, received_at + make_interval(days => ${days})) < ${now.toISOString()}::timestamptz returning id
    `);
    const events = await db.execute(sql`
      delete from inbound_events where state in ('processed', 'ignored') and received_at < ${now.toISOString()}::timestamptz - interval '90 days' returning id
    `);
    return { rawPayloads: [...raw].length, inboundEvents: [...events].length };
  });
}
