import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import {
  LEAD_SOURCE_LABELS,
  STAGE_HINTS,
  reportQuerySchema,
  roleHasCapability,
  type FunnelStep,
  type LeadSource,
  type ReportQuery,
  type ReportSummary,
} from "@skincrm/contracts";
import { getContext, getTx } from "../context";
import { badRequest } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { clinicLocalToUtc } from "../calendar/timezone";

/**
 * Reporting (PRD REP-01…04).
 *
 * The funnel counts how far each lead *got*, not where it sits now: a lead
 * that reached Qualified and was then lost still counts as qualified. "Got to"
 * is the furthest open stage in its stage history, plus the write-once
 * milestones — so leads moving around (or the forward-only rule, D-69) never
 * change last month's numbers. Test leads are excluded everywhere.
 *
 * Everything runs inside the tenant transaction, so RLS scopes every table to
 * the clinic without a clinic_id filter in the SQL.
 */
export function registerReportRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "GET",
    url: "/reports/summary",
    auth: { capability: "reports:read" },
    query: reportQuerySchema,
    handler: async ({ query }) => summary(query),
  });

  registerRoute(app, {
    method: "GET",
    url: "/reports/export",
    auth: { capability: "reports:export" },
    query: reportQuerySchema,
    handler: async ({ query, reply }) => {
      const context = getContext();
      const { start, end } = window(query);
      // Personal columns only for roles that may see people (PRD REP-04).
      const personal = roleHasCapability(context.role!, "people:read");
      const rows = await getTx().execute<Record<string, string | null>>(sql`
        ${reachedCte(start, end, query.source)}
        select r.created_at, r.source, st.name as stage,
               ${personal ? sql`p.display_name as name, p.phone_raw as phone, p.email_raw as email,` : sql``}
               s.campaign_name, s.campaign_id, s.ad_id, s.form_id,
               l.first_contacted_at, l.booked_at, l.attended_at, l.converted_at, l.loss_reason, u.full_name as owner
        from reached r
        join leads l on l.id = r.id
        join people p on p.id = l.person_id
        join pipeline_stages st on st.id = l.stage_id
        left join users u on u.id = l.owner_user_id
        left join lateral (
          select ss.* from source_submissions ss
          where ss.id = l.source_submission_id or (ss.lead_id = l.id and ss.source <> 'whatsapp_organic')
          order by ss.received_at desc limit 1
        ) s on true
        order by r.created_at
      `);
      const list = [...rows];
      await recordAudit({
        action: "export_generated",
        entityType: "report",
        entityId: context.clinicId!,
        changeSummary: { rows: list.length, from: query.from, to: query.to, personalColumns: personal },
      });
      const columns = list[0] ? Object.keys(list[0]) : ["created_at"];
      const csv = [columns.join(","), ...list.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n");
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="leads-${query.from}-to-${query.to}.csv"`);
      return `\uFEFF${csv}`;
    },
  });
}

function window(query: ReportQuery) {
  if (query.from > query.to) throw badRequest("The start date is after the end date.");
  const tz = getContext().clinicTimezone ?? "UTC";
  const start = clinicLocalToUtc(query.from, "00:00", tz);
  const endDay = new Date(`${query.to}T12:00:00Z`);
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const end = clinicLocalToUtc(endDay.toISOString().slice(0, 10), "00:00", tz);
  return { start, end, tz };
}

/** Leads created in the window, with how far each one got. */
function reachedCte(start: Date, end: Date, source?: string) {
  return sql`
    with stage_pos as (
      select category, position from pipeline_stages where is_active
    ),
    reached as (
      select l.id, l.created_at, l.source, l.owner_user_id, l.closed_at,
        greatest(
          coalesce((select max(ps.position) from lead_stage_events e
                    join pipeline_stages ps on ps.id = e.to_stage_id
                    where e.lead_id = l.id and ps.is_active and not ps.is_closed), 0),
          case when l.first_contacted_at is not null then (select position from stage_pos where category = 'connected') else 0 end,
          case when l.booked_at is not null or l.qualified_at is not null then (select position from stage_pos where category = 'consultation_booked') else 0 end,
          case when l.attended_at is not null then (select position from stage_pos where category = 'consultation_attended') else 0 end
        ) as furthest,
        l.converted_at is not null as won,
        cur.category = 'lost' as lost
      from leads l
      join pipeline_stages cur on cur.id = l.stage_id
      where l.created_at >= ${start.toISOString()}::timestamptz and l.created_at < ${end.toISOString()}::timestamptz
        and not l.is_test and l.archived_at is null
        ${source ? sql`and l.source = ${source}` : sql``}
    )
  `;
}

async function summary(query: ReportQuery): Promise<ReportSummary> {
  const tx = getTx();
  const { start, end, tz } = window(query);
  const cte = reachedCte(start, end, query.source);
  const pos = (category: string) => sql`(select position from stage_pos where category = ${category})`;

  const funnelRow = (
    await tx.execute<{ total: number; contacted: number; qualified: number; visited: number; won: number; lost: number }>(sql`
      ${cte}
      select count(*)::int as total,
        count(*) filter (where furthest >= ${pos("connected")} or won)::int as contacted,
        count(*) filter (where furthest >= ${pos("consultation_booked")} or won)::int as qualified,
        count(*) filter (where furthest >= ${pos("consultation_attended")} or won)::int as visited,
        count(*) filter (where won)::int as won,
        count(*) filter (where lost)::int as lost
      from reached
    `)
  )[0]!;

  const steps: [FunnelStep["key"], string, string, number][] = [
    ["new", "New leads", STAGE_HINTS.new!, funnelRow.total],
    ["contacted", "Contacted", STAGE_HINTS.connected!, funnelRow.contacted],
    ["qualified", "Qualified", STAGE_HINTS.consultation_booked!, funnelRow.qualified],
    ["visited", "Visited", STAGE_HINTS.consultation_attended!, funnelRow.visited],
    ["won", "Won", STAGE_HINTS.converted!, funnelRow.won],
  ];
  const funnel: FunnelStep[] = steps.map(([key, label, hint, count], i) => ({
    key,
    label,
    hint,
    count,
    ofTotal: funnelRow.total ? count / funnelRow.total : 0,
    ofPrevious: i === 0 ? 1 : steps[i - 1]![3] ? count / steps[i - 1]![3] : 0,
  }));

  const sources = await tx.execute<{ source: string; leads: number; qualified: number; visited: number; won: number; lost: number }>(sql`
    ${cte}
    select source::text, count(*)::int as leads,
      count(*) filter (where furthest >= ${pos("consultation_booked")} or won)::int as qualified,
      count(*) filter (where furthest >= ${pos("consultation_attended")} or won)::int as visited,
      count(*) filter (where won)::int as won,
      count(*) filter (where lost)::int as lost
    from reached group by source order by leads desc
  `);

  const leadRows = await tx.execute<{ platform: string; campaign: string; campaign_id: string | null; leads: number; qualified: number; won: number }>(sql`
    ${cte}
    select s.platform::text as platform,
      coalesce(s.campaign_name, s.campaign_id, s.form_name, s.form_id, s.ad_id, 'Not recorded') as campaign,
      s.campaign_id,
      count(*)::int as leads,
      count(*) filter (where r.furthest >= ${pos("consultation_booked")} or r.won)::int as qualified,
      count(*) filter (where r.won)::int as won
    from reached r
    join leads l on l.id = r.id
    join lateral (
      select ss.* from source_submissions ss
      where (ss.id = l.source_submission_id or ss.lead_id = l.id)
        and ss.platform in ('meta', 'google', 'whatsapp') and ss.source <> 'whatsapp_organic'
      order by ss.received_at desc limit 1
    ) s on true
    where s.platform in ('meta', 'google', 'whatsapp') and s.source <> 'whatsapp_organic'
    group by 1, 2, 3 order by leads desc limit 50
  `);
  // Spend copied from the connected ad accounts (D-95), same clinic-local days.
  const spendRows = await tx.execute<{ platform: string; campaign_id: string; campaign_name: string; spend: string; currency: string }>(sql`
    select platform, campaign_id, max(campaign_name) as campaign_name, sum(spend_micros)::text as spend, max(currency) as currency
    from ad_spend_daily where day between ${query.from}::date and ${query.to}::date
    group by 1, 2
  `);
  const spendById = new Map([...spendRows].map((r) => [r.campaign_id, r]));
  const campaigns = [...leadRows].map((r) => {
    const spend = r.campaign_id ? spendById.get(r.campaign_id) : undefined;
    if (spend) spendById.delete(r.campaign_id!);
    return { platform: r.platform, campaign: r.campaign, campaignId: r.campaign_id, leads: r.leads, qualified: r.qualified, won: r.won,
      spendMicros: spend ? Number(spend.spend) : null, currency: spend?.currency ?? null };
  });
  // Campaigns that spent money but brought no leads matter most.
  for (const spend of spendById.values()) {
    if (Number(spend.spend) <= 0) continue;
    campaigns.push({ platform: spend.platform, campaign: spend.campaign_name, campaignId: spend.campaign_id, leads: 0, qualified: 0, won: 0, spendMicros: Number(spend.spend), currency: spend.currency });
  }

  const trend = await tx.execute<{ day: string; leads: number; qualified: number }>(sql`
    ${cte}
    select to_char(created_at at time zone ${tz}, 'YYYY-MM-DD') as day, count(*)::int as leads,
      count(*) filter (where furthest >= ${pos("consultation_booked")} or won)::int as qualified
    from reached group by 1 order by 1
  `);

  const ops = (
    await tx.execute<{
      median_minutes: number | null;
      within_hour: number;
      unassigned_open: number;
      overdue_tasks: number;
      booked: number;
      attended: number;
      no_shows: number;
      sent: number;
      not_sent: number;
      open_conversations: number;
    }>(sql`
      ${cte},
      first_touch as (
        select r.id, r.created_at,
          least(
            (select min(occurred_at) from activities a where a.lead_id = r.id and a.type in ('call','email_sent','whatsapp_sent')),
            (select min(e.occurred_at) from lead_stage_events e join pipeline_stages ps on ps.id = e.to_stage_id
               where e.lead_id = r.id and ps.category <> 'new')
          ) as touched_at
        from reached r
      )
      select
        (select percentile_cont(0.5) within group (order by extract(epoch from touched_at - created_at) / 60)
           from first_touch where touched_at is not null) as median_minutes,
        (select count(*)::int from first_touch where touched_at is not null and touched_at - created_at <= interval '1 hour') as within_hour,
        (select count(*)::int from leads where owner_user_id is null and closed_at is null and archived_at is null and not is_test) as unassigned_open,
        (select count(*)::int from tasks where status = 'open' and due_at < now()) as overdue_tasks,
        (select count(*)::int from appointments where created_at >= ${start.toISOString()}::timestamptz and created_at < ${end.toISOString()}::timestamptz and rescheduled_from_id is null) as booked,
        (select count(*)::int from appointments where starts_at >= ${start.toISOString()}::timestamptz and starts_at < ${end.toISOString()}::timestamptz and status = 'attended') as attended,
        (select count(*)::int from appointments where starts_at >= ${start.toISOString()}::timestamptz and starts_at < ${end.toISOString()}::timestamptz and status = 'no_show') as no_shows,
        (select count(*)::int from messages where direction = 'outbound' and created_at >= ${start.toISOString()}::timestamptz and created_at < ${end.toISOString()}::timestamptz and state in ('sent','delivered','read')) as sent,
        (select count(*)::int from messages where direction = 'outbound' and created_at >= ${start.toISOString()}::timestamptz and created_at < ${end.toISOString()}::timestamptz and state in ('suppressed','failed','bounced')) as not_sent,
        (select count(*)::int from conversations where status <> 'resolved' and last_message_at is not null) as open_conversations
    `)
  )[0]!;

  return {
    range: { from: query.from, to: query.to, timezone: tz },
    funnel,
    lost: funnelRow.lost,
    sources: [...sources].map((s) => ({ ...s, label: LEAD_SOURCE_LABELS[s.source as LeadSource] ?? s.source })),
    campaigns,
    trend: [...trend],
    operations: {
      medianMinutesToFirstContact: ops.median_minutes === null ? null : Math.round(Number(ops.median_minutes)),
      contactedWithinHour: ops.within_hour,
      unassignedOpen: ops.unassigned_open,
      overdueTasks: ops.overdue_tasks,
      appointmentsBooked: ops.booked,
      attended: ops.attended,
      noShows: ops.no_shows,
      noShowRate: ops.attended + ops.no_shows ? ops.no_shows / (ops.attended + ops.no_shows) : null,
      messagesSent: ops.sent,
      messagesNotSent: ops.not_sent,
      openConversations: ops.open_conversations,
    },
  };
}

/** CSV cell, with formula-injection protection for spreadsheet apps. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
