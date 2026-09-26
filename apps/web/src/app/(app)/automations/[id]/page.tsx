import { STEP_LABELS, type EnrollmentDto } from "@skincrm/contracts";
import { Badge, Card, EmptyState } from "@/components/ui";
import { getAutomation, getAutomationOptions, getAutomationRuns } from "@/lib/automations";
import { clinicTime, relativeTime } from "@/lib/format";
import { requireCapability } from "@/lib/session";
import { AutomationBuilder } from "../builder/builder";

export const metadata = { title: "Automation — SkinCRM" };

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("automations:read");
  const { id } = await params;
  const [automation, options, runs] = await Promise.all([getAutomation(id), getAutomationOptions(), getAutomationRuns(id)]);

  return (
    <div className="flex flex-col gap-8">
      <AutomationBuilder
        // Remount after a save so the builder starts from what the server stored.
        key={automation.updatedAt}
        id={automation.id}
        initial={{ name: automation.name, trigger: automation.trigger, steps: automation.steps, stopWhen: automation.stopWhen }}
        status={automation.status}
        options={options}
      />

      <section aria-labelledby="runs">
        <h2 id="runs" className="text-[15px] font-semibold">
          Who&rsquo;s been through it
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">The last 100 people, newest first. Open one to see each step.</p>
        <div className="mt-3">
          {runs.length === 0 ? (
            <Card>
              <EmptyState title="Nobody yet">
                {automation.status === "active"
                  ? "People will appear here as they match the trigger."
                  : "Switch it on, and people will appear here as they match the trigger."}
              </EmptyState>
            </Card>
          ) : (
            <ul className="flex flex-col gap-2">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} timezone={session.clinic.timezone} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

const STATE_BADGE: Record<EnrollmentDto["state"], { tone: "brand" | "positive" | "neutral" | "critical"; label: string }> = {
  active: { tone: "brand", label: "In progress" },
  completed: { tone: "positive", label: "Finished" },
  stopped: { tone: "neutral", label: "Stopped" },
  failed: { tone: "critical", label: "Failed" },
};

const OUTCOME_TEXT: Record<string, string> = {
  done: "Done",
  skipped: "Skipped",
  blocked: "Not sent",
  failed: "Failed",
  stopped: "Stopped",
};

function RunRow({ run, timezone }: { run: EnrollmentDto; timezone: string }) {
  const badge = STATE_BADGE[run.state];
  return (
    <li>
      <details className="group rounded-card border border-line bg-surface">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1 font-medium">{run.personName}</span>
          <span className="text-sm text-ink-muted">
            {run.state === "active" && run.nextRunAt
              ? `Next step ${clinicTime(run.nextRunAt, timezone)}`
              : run.stopReason ?? `Started ${relativeTime(run.startedAt)}`}
          </span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </summary>
        <ol className="border-t border-line px-4 py-3 text-sm">
          {run.history.length === 0 && <li className="text-ink-muted">Waiting to start.</li>}
          {run.history.map((entry, i) => (
            <li key={i} className="flex flex-wrap gap-x-3 py-1">
              <span className="w-40 shrink-0 text-ink-subtle">{clinicTime(entry.at, timezone)}</span>
              <span className="font-medium">
                {STEP_LABELS[entry.stepType as keyof typeof STEP_LABELS]?.title ?? entry.stepType}
              </span>
              <span className={entry.outcome === "blocked" || entry.outcome === "failed" ? "text-critical" : "text-ink-muted"}>
                {OUTCOME_TEXT[entry.outcome]}
                {entry.detail ? ` — ${entry.detail}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}
