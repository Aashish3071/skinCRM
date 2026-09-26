import Link from "next/link";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, type ReportSummary } from "@skincrm/contracts";
import { Card, EmptyState, PageHeader, buttonClasses } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { can, requireCapability } from "@/lib/session";
import { RangePicker } from "./range";

export const metadata = { title: "Reports — SkinCRM" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function localDay(offsetDays: number, tz: string) {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * How the clinic is doing, in plain numbers (PRD REP-01…04). The funnel
 * reads top to bottom like the pipeline; every number has a sentence next to
 * it, because most people reading this are not analysts.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("reports:read");
  const params = await searchParams;
  const tz = session.clinic.timezone;
  const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
  const to = valid(one(params.to)) ?? localDay(0, tz);
  const from = valid(one(params.from)) ?? localDay(-29, tz);
  const source = LEAD_SOURCES.find((s) => s === one(params.source));
  const q = new URLSearchParams({ from, to, ...(source ? { source } : {}) });
  const data = await apiFetch<ReportSummary>(`/reports/summary?${q}`);
  const total = data.funnel[0]!.count;
  const ops = data.operations;
  const maxTrend = Math.max(1, ...data.trend.map((t) => t.leads));

  return (
    <>
      <PageHeader
        title="Reports"
        description="Where your leads come from and how many become clients. Test leads are not counted."
        actions={can(session, "reports:export") ? (
          <a href={`/reports/export?${q}`} className={buttonClasses("secondary")} download>Download leads (CSV)</a>
        ) : null}
      />
      <RangePicker from={from} to={to} source={source ?? ""} timezone={tz} sources={LEAD_SOURCES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }))} />

      {total === 0 ? (
        <Card><EmptyState title="No leads in these dates">Try a longer period, or check that lead sources are connected in Settings.</EmptyState></Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="New leads" value={String(total)} note={`${data.trend.length} days with leads`} />
            <Kpi label="Qualified (booked)" value={pct(data.funnel[2]!.ofTotal)} note={`${data.funnel[2]!.count} of ${total} leads`} />
            <Kpi label="Became clients" value={String(data.funnel[4]!.count)} note={`${pct(data.funnel[4]!.ofTotal)} of leads`} />
            <Kpi label="First reply" value={formatMinutes(ops.medianMinutesToFirstContact)} note="typical time to first contact" />
          </div>

          <Card title="From lead to client" description="How far the leads that came in during these dates have got.">
            <ol className="flex flex-col gap-3">
              {data.funnel.map((step, i) => (
                <li key={step.key}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span><span className="font-semibold">{step.label}</span> <span className="text-ink-subtle">· {step.hint}</span></span>
                    <span className="shrink-0 tabular-nums"><span className="font-semibold">{step.count}</span> <span className="text-ink-muted">({pct(step.ofTotal)})</span></span>
                  </div>
                  <div className="mt-1 h-3 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(step.ofTotal * 100, step.count ? 2 : 0)}%` }} />
                  </div>
                  {i > 0 && <p className="mt-0.5 text-xs text-ink-subtle">{pct(step.ofPrevious)} of those {data.funnel[i - 1]!.label.toLowerCase()} got this far</p>}
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm text-ink-muted">{data.lost} {data.lost === 1 ? "lead was" : "leads were"} marked Lost.</p>
          </Card>

          <Card title="New leads per day">
            <div className="flex h-40 items-end gap-[2px]" role="img" aria-label={`Leads per day from ${from} to ${to}. Busiest day: ${maxTrend}.`}>
              {data.trend.map((t) => (
                <div key={t.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${t.day}: ${t.leads} leads, ${t.qualified} qualified`}>
                  <div className="flex w-full flex-col justify-end overflow-hidden rounded-t bg-brand-soft" style={{ height: `${(t.leads / maxTrend) * 100}%` }}>
                    <div className="w-full bg-brand" style={{ height: `${t.leads ? (t.qualified / t.leads) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 flex gap-4 text-xs text-ink-muted">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-soft" /> All leads</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand" /> Went on to qualify</span>
            </p>
          </Card>

          <Card title="Where leads come from">
            <table className="stack-table w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-subtle">
                  <th scope="col" className="py-2 font-medium">Source</th>
                  <th scope="col" className="py-2 text-right font-medium">Leads</th>
                  <th scope="col" className="py-2 text-right font-medium">Qualified</th>
                  <th scope="col" className="py-2 text-right font-medium">Visited</th>
                  <th scope="col" className="py-2 text-right font-medium">Won</th>
                  <th scope="col" className="py-2 text-right font-medium">Lead → client</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.source} className="border-b border-line last:border-0">
                    <td className="py-2.5 font-medium">
                      <Link href={`/reports?${new URLSearchParams({ from, to, source: s.source })}`} className="hover:text-brand">{s.label}</Link>
                    </td>
                    <td data-label="Leads" className="py-2.5 text-right tabular-nums">{s.leads}</td>
                    <td data-label="Qualified" className="py-2.5 text-right tabular-nums">{s.qualified}</td>
                    <td data-label="Visited" className="py-2.5 text-right tabular-nums">{s.visited}</td>
                    <td data-label="Won" className="py-2.5 text-right tabular-nums">{s.won}</td>
                    <td data-label="Lead → client" className="py-2.5 text-right tabular-nums">{pct(s.leads ? s.won / s.leads : 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {data.campaigns.length > 0 && (
            <Card title="Ad campaigns" description="Leads from Facebook, Instagram and Google ads, by campaign.">
              <table className="stack-table w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-subtle">
                    <th scope="col" className="py-2 font-medium">Campaign</th>
                    <th scope="col" className="py-2 font-medium">Platform</th>
                    <th scope="col" className="py-2 text-right font-medium">Leads</th>
                    <th scope="col" className="py-2 text-right font-medium">Qualified</th>
                    <th scope="col" className="py-2 text-right font-medium">Won</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c) => (
                    <tr key={`${c.platform}-${c.campaign}`} className="border-b border-line last:border-0">
                      <td className="max-w-64 truncate py-2.5 font-medium">{c.campaign}</td>
                      <td data-label="Platform" className="py-2.5 text-ink-muted">{c.platform === "meta" ? "Facebook / Instagram" : "Google"}</td>
                      <td data-label="Leads" className="py-2.5 text-right tabular-nums">{c.leads}</td>
                      <td data-label="Qualified" className="py-2.5 text-right tabular-nums">{c.qualified}</td>
                      <td data-label="Won" className="py-2.5 text-right tabular-nums">{c.won}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card title="How the front desk is doing">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Stat label="Leads contacted within an hour" value={`${ops.contactedWithinHour} of ${total}`} />
              <Stat label="Open leads nobody owns" value={String(ops.unassignedOpen)} warn={ops.unassignedOpen > 0} href="/leads?unassigned=true" />
              <Stat label="Overdue tasks" value={String(ops.overdueTasks)} warn={ops.overdueTasks > 0} href="/home" />
              <Stat label="Appointments booked" value={String(ops.appointmentsBooked)} />
              <Stat label="Missed appointments (no-show rate)" value={ops.noShowRate === null ? "—" : `${ops.noShows} (${pct(ops.noShowRate)})`} warn={(ops.noShowRate ?? 0) > 0.2} />
              <Stat label="Messages sent / not sent" value={`${ops.messagesSent} / ${ops.messagesNotSent}`} warn={ops.messagesNotSent > 0} href="/automations/messages?state=suppressed" />
              <Stat label="Open WhatsApp conversations" value={String(ops.openConversations)} href="/inbox" />
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-ink-subtle">{note}</p>
    </div>
  );
}

function Stat({ label, value, warn, href }: { label: string; value: string; warn?: boolean; href?: string }) {
  const inner = <span className={`font-semibold tabular-nums ${warn ? "text-caution" : ""}`}>{value}</span>;
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd>{href ? <Link href={href} className="hover:underline">{inner}</Link> : inner}</dd>
    </div>
  );
}

function formatMinutes(m: number | null): string {
  if (m === null) return "—";
  if (m < 60) return `${m} min`;
  if (m < 60 * 48) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}
