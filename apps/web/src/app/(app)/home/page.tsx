import Link from "next/link";
import type { ComponentType } from "react";
import { CalendarIcon, ClockIcon, LeadsIcon, TaskIcon } from "@/components/icons";
import { SlaBadge } from "@/components/sla-badge";
import { Badge, Card, EmptyState } from "@/components/ui";
import { getAppointments } from "@/lib/calendar";
import { appointmentLabels, clockTime, localDate } from "@/lib/calendar-view";
import { getLeads, getTasks, relativeTime } from "@/lib/crm";
import { can, requireSession } from "@/lib/session";

export const metadata = { title: "Home — SkinCRM" };

/**
 * Today at a glance: what needs doing now, and nothing about how the system
 * is configured (that lives in Settings). Four numbers across the top, each a
 * link to the list behind it; the lists below are the first few of each.
 */
export default async function HomePage() {
  const session = await requireSession();
  const tz = session.clinic.timezone;
  const firstName = session.fullName.split(" ")[0] ?? session.fullName;
  const today = localDate(new Date(), tz);
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const canLeads = can(session, "leads:read");
  const canTasks = can(session, "tasks:read");
  const canCalendar = can(session, "appointments:read");

  const [overdue, dueToday, unassigned, awaiting, appointments] = await Promise.all([
    canTasks ? getTasks("dueView=overdue&mine=true&limit=25") : null,
    canTasks ? getTasks("dueView=today&mine=true&limit=25") : null,
    canLeads ? getLeads("unassigned=true&includeClosed=false&limit=6") : null,
    canLeads ? getLeads("awaitingResponse=true&includeClosed=false&limit=6") : null,
    canCalendar ? getAppointments(`from=${today}&to=${today}`) : null,
  ]);
  const tasks = dedupeById([...(overdue ?? []), ...(dueToday ?? [])]);
  const visits = (appointments?.items ?? [])
    .filter((a) => a.status !== "canceled" && a.status !== "rescheduled")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const upcoming = visits.filter((a) => new Date(a.clientVisibleEndsAt ?? a.endsAt).getTime() > Date.now());

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{greeting}, {firstName}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {new Date().toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" })}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {canTasks && <Tile icon={TaskIcon} label="Overdue tasks" value={overdue?.length ?? 0} href="/activity?group=tasks" tone={overdue?.length ? "critical" : "neutral"} />}
        {canLeads && <Tile icon={ClockIcon} label="Waiting for a reply" value={awaiting?.totalCount ?? 0} href="/leads" tone={awaiting?.totalCount ? "caution" : "neutral"} />}
        {canLeads && <Tile icon={LeadsIcon} label="Unassigned leads" value={unassigned?.totalCount ?? 0} href="/leads?unassigned=true" tone={unassigned?.totalCount ? "caution" : "neutral"} />}
        {canCalendar && <Tile icon={CalendarIcon} label="Appointments today" value={visits.length} href={`/calendar?view=day&date=${today}`} />}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {canCalendar && (
          <Card title="Today's appointments" actions={<Link href={`/calendar?view=day&date=${today}`} className="text-sm text-brand">Calendar</Link>}>
            {visits.length === 0 ? (
              <EmptyState title="Nothing booked today" />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {visits.slice(0, 6).map((a) => {
                  const past = !upcoming.includes(a);
                  return (
                    <li key={a.id} className={`flex items-center gap-3 py-2.5 ${past ? "opacity-60" : ""}`}>
                      <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">{clockTime(a.startsAt, tz)}</span>
                      <span className="min-w-0 flex-1">
                        <Link href={a.leadId ? `/leads/${a.leadId}` : `/people/${a.personId}`} className="block truncate font-medium hover:text-brand">{a.personName}</Link>
                        <span className="block truncate text-xs text-ink-subtle">{a.consultationTypeName ?? "Consultation"} · {a.staffName}</span>
                      </span>
                      <Badge tone={a.status === "attended" ? "positive" : a.status === "no_show" ? "critical" : "neutral"}>{appointmentLabels[a.status]}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        {canTasks && (
          <Card title="Your tasks" description="Overdue first, then due today.">
            {tasks.length === 0 ? (
              <EmptyState title="Nothing due">You&rsquo;re clear for now.</EmptyState>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {tasks.slice(0, 6).map((task) => {
                  const late = new Date(task.dueAt).getTime() < Date.now();
                  return (
                    <li key={task.id} className="flex items-start justify-between gap-3 py-2.5">
                      <span className="min-w-0">
                        {task.leadId ? (
                          <Link href={`/leads/${task.leadId}`} className="block truncate font-medium hover:text-brand">{task.title}</Link>
                        ) : (
                          <span className="block truncate font-medium">{task.title}</span>
                        )}
                        <span className="block text-xs text-ink-subtle">{task.personName ? `${task.personName} · ` : ""}due {relativeTime(task.dueAt)}</span>
                      </span>
                      {late ? <Badge tone="critical">Overdue</Badge> : <Badge>Today</Badge>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        {canLeads && (
          <Card title="Waiting for a first reply" description="New leads nobody has contacted yet.">
            {(awaiting?.items.length ?? 0) === 0 ? (
              <EmptyState title="Everyone has had a reply" />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {awaiting!.items.map((lead) => (
                  <li key={lead.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <Link href={`/leads/${lead.id}`} className="block truncate font-medium hover:text-brand">{lead.personName}</Link>
                      <span className="block text-xs text-ink-subtle">{lead.ownerName ?? "Unassigned"} · came in {relativeTime(lead.createdAt)}</span>
                    </span>
                    <SlaBadge lead={lead} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {canLeads && (
          <Card title="Nobody owns these yet" actions={<Link href="/leads?unassigned=true" className="text-sm text-brand">View all</Link>}>
            {(unassigned?.items.length ?? 0) === 0 ? (
              <EmptyState title="Every open lead has an owner" />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {unassigned!.items.map((lead) => (
                  <li key={lead.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <Link href={`/leads/${lead.id}`} className="block truncate font-medium hover:text-brand">{lead.personName}</Link>
                      <span className="block text-xs text-ink-subtle">came in {relativeTime(lead.createdAt)}</span>
                    </span>
                    <Badge>{lead.stageName}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

/** Overdue tasks are also "due today", so the two lists overlap. */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

function Tile({ icon: Icon, label, value, href, tone = "neutral" }: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  value: number;
  href: string;
  tone?: "neutral" | "caution" | "critical";
}) {
  const colour = tone === "critical" ? "text-critical" : tone === "caution" ? "text-caution" : "text-ink";
  return (
    <Link href={href} className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)] hover:border-brand">
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon size={20} /></span>
      <span>
        <span className={`block text-2xl font-semibold tabular-nums leading-tight ${colour}`}>{value}</span>
        <span className="block text-sm text-ink-muted">{label}</span>
      </span>
    </Link>
  );
}
