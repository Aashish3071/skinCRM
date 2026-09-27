import Link from "next/link";
import type { AssignmentRuleDto, LeadRulesSettings } from "@skincrm/contracts";
import { PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { getCalendarOptions } from "@/lib/calendar";
import { can, requireCapability } from "@/lib/session";
import { AssignmentRules, SlaCard } from "./client";

export const metadata = { title: "Lead rules — SkinCRM" };

export default async function LeadRulesPage() {
  const session = await requireCapability("settings:read");
  const [sla, rules, options] = await Promise.all([
    apiFetch<LeadRulesSettings>("/settings/lead-rules"),
    apiFetch<{ items: AssignmentRuleDto[] }>("/assignment-rules").then((r) => r.items),
    getCalendarOptions(),
  ]);
  const writable = can(session, "settings:write");
  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader title="Lead rules" description="How fast the team should respond, and who gets each new lead." />
      {!writable && <p className="mb-4 text-sm text-ink-muted">Only an admin can change these.</p>}
      <div className="flex flex-col gap-4">
        <SlaCard initial={sla} writable={writable} />
        <AssignmentRules rules={rules} staff={options.staff} branches={options.branches} writable={writable} />
        <p className="text-sm text-ink-muted">
          Want something else to happen automatically — an email to the team, a welcome message, a reminder task?{" "}
          <Link href="/automations" className="text-brand">Set it up in Automations</Link>.
        </p>
      </div>
    </>
  );
}
