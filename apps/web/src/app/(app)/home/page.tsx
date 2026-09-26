import { Badge, Card, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Home — SkinCRM" };

/**
 * The work queue from PRD section 6.1. The tiles are wired to real counts as each
 * phase lands; until then each one says plainly that it has no data source yet
 * rather than showing a zero that looks like a real number.
 */
export default async function HomePage() {
  const session = await requireSession();
  const firstName = session.fullName.split(" ")[0] ?? session.fullName;

  return (
    <>
      <PageHeader
        title={`Good day, ${firstName}`}
        description="Your queue for today. Overdue follow-ups come first, then appointments, then anything the integrations need."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QueueTile label="Overdue tasks" requirement="LEAD-05" phase="Phase 2" />
        <QueueTile label="Unassigned leads" requirement="LEAD-03" phase="Phase 2" />
        <QueueTile label="Appointments today" requirement="CAL-01" phase="Phase 3" />
        <QueueTile label="Integration alerts" requirement="INT-01" phase="Phase 7" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Setup status" description="What this deployment can and cannot do right now.">
          <dl className="flex flex-col gap-3 text-sm">
            <StatusRow label="Clinic timezone" value={session.clinic.timezone} tone="neutral" />
            <StatusRow label="Country" value={session.clinic.country} tone="neutral" />
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

        <Card title="Your access" description="What your role can do. The API enforces the same list.">
          <p className="text-sm text-ink-muted">
            You are signed in as <strong className="text-ink">{session.role}</strong> with{" "}
            {session.capabilities.length} permissions.
          </p>
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {session.capabilities.map((capability) => (
              <li
                key={capability}
                className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-ink-muted"
              >
                {capability}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function QueueTile({
  label,
  requirement,
  phase,
}: {
  label: string;
  requirement: string;
  phase: string;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-4">
      <p className="text-sm font-medium">{label}</p>
      {/* An em dash rather than 0: there is no data source yet, and a zero would
          read as a real, reassuring count. */}
      <p className="mt-2 text-2xl font-semibold tabular-nums text-ink-subtle">—</p>
      <p className="mt-2 text-xs text-ink-subtle">
        {phase} · <span className="font-mono">{requirement}</span>
      </p>
    </div>
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
