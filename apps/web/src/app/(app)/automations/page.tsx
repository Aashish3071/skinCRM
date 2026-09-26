import Link from "next/link";
import { AUTOMATION_RECIPES, STEP_LABELS, TRIGGER_LABELS, type AutomationDto } from "@skincrm/contracts";
import { ChevronRightIcon, PlusIcon, ZapIcon } from "@/components/icons";
import { Badge, Card, PageHeader, buttonClasses } from "@/components/ui";
import { getAutomations } from "@/lib/automations";
import { can, requireCapability } from "@/lib/session";
import { StatusToggle } from "./status-toggle";

export const metadata = { title: "Automations — SkinCRM" };

export default async function AutomationsPage() {
  const session = await requireCapability("automations:read");
  const automations = await getAutomations();
  const writable = can(session, "automations:write");

  return (
    <>
      <PageHeader
        title="Automations"
        description="Send the right email or WhatsApp, or remind your team, when something happens — automatically."
        actions={
          writable ? (
            <Link href="/automations/new" className={buttonClasses("primary")}>
              <PlusIcon size={16} /> New automation
            </Link>
          ) : null
        }
      />

      {automations.length > 0 && (
        <ul className="mb-10 flex flex-col gap-3">
          {automations.map((automation) => (
            <AutomationRow key={automation.id} automation={automation} writable={writable} />
          ))}
        </ul>
      )}

      {writable && (
        <section aria-labelledby="recipes">
          <h2 id="recipes" className="text-[15px] font-semibold">
            {automations.length === 0 ? "Start with one of these" : "More ideas"}
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">Opens ready to edit. Nothing runs until you switch it on.</p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {AUTOMATION_RECIPES.map((recipe) => (
              <li key={recipe.key}>
                <Link
                  href={`/automations/new?recipe=${recipe.key}`}
                  className="flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)] transition-colors hover:border-brand"
                >
                  <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
                    <ZapIcon size={18} />
                  </span>
                  <span className="mt-3 text-sm font-semibold">{recipe.name}</span>
                  <span className="mt-1 flex-1 text-sm text-ink-muted">{recipe.description}</span>
                  <span className="mt-3 text-sm font-medium text-brand">Use this →</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AutomationRow({ automation, writable }: { automation: AutomationDto; writable: boolean }) {
  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <Link href={`/automations/${automation.id}`} className="group min-w-0 flex-1">
            <p className="flex items-center gap-2 font-semibold group-hover:text-brand">
              {automation.name}
              <ChevronRightIcon size={16} />
            </p>
            <p className="mt-0.5 text-sm text-ink-muted">
              When: {TRIGGER_LABELS[automation.trigger.type].title.toLowerCase()} ·{" "}
              {automation.steps.map((s) => STEP_LABELS[s.type].title.toLowerCase()).join(" → ")}
            </p>
          </Link>
          <div className="flex items-center gap-4">
            <p className="text-right text-xs text-ink-subtle">
              <span className="block tabular-nums">{automation.activeCount} in progress</span>
              <span className="block tabular-nums">{automation.completedCount} finished</span>
            </p>
            {writable ? (
              <StatusToggle id={automation.id} status={automation.status} />
            ) : (
              <Badge tone={automation.status === "active" ? "positive" : "neutral"}>
                {automation.status === "active" ? "On" : "Off"}
              </Badge>
            )}
          </div>
        </div>
      </Card>
    </li>
  );
}
