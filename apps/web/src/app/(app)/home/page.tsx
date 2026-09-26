import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { getLeads, getTasks, relativeTime } from "@/lib/crm";
import { can, requireSession } from "@/lib/session";

export const metadata = { title: "Home — SkinCRM" };

/** The work queue from PRD section 6.1. */
export default async function HomePage() {
  const session = await requireSession();
  const firstName = session.fullName.split(" ")[0] ?? session.fullName;

  const canLeads = can(session, "leads:read");
  const canTasks = can(session, "tasks:read");

  const [overdue, mine, unassigned] = await Promise.all([
    canTasks ? getTasks("dueView=overdue&mine=true&limit=25") : Promise.resolve(null),
    canTasks ? getTasks("dueView=today&mine=true&limit=25") : Promise.resolve(null),
    canLeads ? getLeads("unassigned=true&includeClosed=false&limit=10") : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader
        title={`Good day, ${firstName}`}
        description="Your queue for today. Overdue follow-ups come first, then appointments, then anything the integrations need."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Your overdue tasks"
          value={overdue?.length}
          href="/leads"
          tone={overdue && overdue.length > 0 ? "critical" : "neutral"}
          unavailable={!canTasks}
        />
        <Tile
          label="Unassigned leads"
          value={unassigned?.totalCount}
          href="/leads?unassigned=true"
          tone={unassigned && unassigned.totalCount > 0 ? "caution" : "neutral"}
          unavailable={!canLeads}
        />
        {/* No data source until phase 3, so an em dash rather than a 0 that
            would read as a real, reassuring count. */}
        <Tile label="Appointments today" pending="Phase 3 · CAL-01" />
        <Tile label="Integration alerts" pending="Phase 7 · INT-01" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {canTasks && (
          <Card
            title="Due and overdue"
            description="Sorted by due time, most overdue first."
            actions={
              <Link href="/leads" className="text-sm text-brand">
                All leads
              </Link>
            }
          >
            {dedupeById([...(overdue ?? []), ...(mine ?? [])]).length === 0 ? (
              <EmptyState title="Nothing due">You are clear for now.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {dedupeById([...(overdue ?? []), ...(mine ?? [])])
                  .slice(0, 8)
                  .map((task) => {
                  const isOverdue = new Date(task.dueAt).getTime() < Date.now();
                    return (
                      <li
                        key={task.id}
                        className="flex items-start justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                      >
                        <div>
                          <p className="text-sm font-medium">
                            {task.leadId ? (
                              <Link href={`/leads/${task.leadId}`} className="text-brand hover:underline">
                                {task.title}
                              </Link>
                            ) : (
                              task.title
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-subtle">
                            {task.personName ? `${task.personName} · ` : ""}
                            due {relativeTime(task.dueAt)}
                          </p>
                        </div>
                        {isOverdue ? <Badge tone="critical">Overdue</Badge> : <Badge>Today</Badge>}
                      </li>
                    );
                  })}
              </ul>
            )}
          </Card>
        )}

        {canLeads && (
          <Card
            title="Unassigned queue"
            description="Nobody owns these yet."
            actions={
              <Link href="/leads?unassigned=true" className="text-sm text-brand">
                View all
              </Link>
            }
          >
            {(unassigned?.items.length ?? 0) === 0 ? (
              <EmptyState title="Queue is empty">Every open inquiry has an owner.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {unassigned!.items.slice(0, 8).map((lead) => (
                  <li
                    key={lead.id}
                    className="flex items-start justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                  >
                    <div>
                      <Link
                        href={`/leads/${lead.id}`}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        {lead.personName}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-subtle">
                        {lead.serviceInterest ?? "No service noted"} · {relativeTime(lead.createdAt)}
                      </p>
                    </div>
                    <Badge>{lead.stageName}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title="Setup status" description="What this deployment can and cannot do right now.">
          <dl className="flex flex-col gap-3 text-sm">
            <StatusRow label="Clinic timezone" value={session.clinic.timezone} tone="neutral" />
            <StatusRow
              label="Outbound messaging"
              value="Off"
              tone="caution"
              note="Email and WhatsApp sending stays disabled until the clinic approves message copy and legal basis."
            />
            <StatusRow
              label="Ad-platform conversion feedback"
              value="Off"
              tone="caution"
              note="Stays off until each destination passes its eligibility check (PRD FB-03)."
            />
            <StatusRow
              label="Integrations"
              value="Mock connectors"
              tone="neutral"
              note="The app is fully usable with sample data before any real credentials are connected."
            />
          </dl>
        </Card>
      </div>
    </>
  );
}

/**
 * The overdue and today queries overlap — anything overdue is also due today —
 * so the same task would otherwise be listed twice.
 */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

function Tile({
  label,
  value,
  href,
  tone = "neutral",
  pending,
  unavailable,
}: {
  label: string;
  value?: number;
  href?: string;
  tone?: "neutral" | "caution" | "critical";
  pending?: string;
  unavailable?: boolean;
}) {
  const body = (
    <div className="rounded-card border border-line bg-surface px-4 py-4">
      <p className="text-sm font-medium">{label}</p>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          pending || unavailable
            ? "text-ink-subtle"
            : tone === "critical"
              ? "text-critical"
              : tone === "caution"
                ? "text-caution"
                : "text-ink"
        }`}
      >
        {pending || unavailable ? "—" : (value ?? 0)}
      </p>
      <p className="mt-2 text-xs text-ink-subtle">
        {pending ?? (unavailable ? "Not available for your role" : "Live")}
      </p>
    </div>
  );

  return href && !pending && !unavailable ? (
    <Link href={href} className="block hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}

function StatusRow({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone: "neutral" | "caution" | "positive";
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-line pb-3 last:border-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-ink-muted">{label}</dt>
        <dd>
          <Badge tone={tone}>{value}</Badge>
        </dd>
      </div>
      {note && <p className="text-xs text-ink-subtle">{note}</p>}
    </div>
  );
}
