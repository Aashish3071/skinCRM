import Link from "next/link";
import { AUDIT_ACTIONS, type AuditAction } from "@skincrm/contracts";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { clinicTime } from "@/lib/format";
import { requireCapability } from "@/lib/session";

export const metadata = { title: "Audit log — SkinCRM" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PAGE = 50;

/** Plain-English names for every audited action. */
const LABELS: Record<AuditAction, string> = {
  login_success: "Signed in",
  login_failure: "Failed sign-in",
  logout: "Signed out",
  password_reset_requested: "Asked for a password reset",
  password_reset_completed: "Reset their password",
  mfa_enabled: "Turned on two-step sign-in",
  mfa_disabled: "Turned off two-step sign-in",
  user_invited: "Invited a team member",
  user_role_changed: "Changed someone's role",
  user_suspended: "Suspended an account",
  record_created: "Created a record",
  record_updated: "Changed a record",
  record_deleted: "Deleted a record",
  sensitive_record_viewed: "Opened a patient record",
  note_edited: "Edited a note",
  note_archived: "Archived a note",
  person_merged: "Merged two patients",
  person_merge_reverted: "Undid a merge",
  consent_changed: "Changed consent",
  export_generated: "Downloaded an export",
  automation_rule_changed: "Changed an automation",
  template_changed: "Changed a message template",
  integration_connected: "Connected an account",
  integration_disconnected: "Disconnected an account",
  integration_credentials_revoked: "Revoked account credentials",
  feedback_mapping_changed: "Changed ad-platform feedback",
  feedback_paused: "Paused ad-platform feedback",
  settings_changed: "Changed settings",
  event_replayed: "Replayed an incoming event",
};

interface AuditRow {
  id: string;
  action: AuditAction;
  actor: string;
  entityType: string | null;
  entityId: string | null;
  changeSummary: Record<string, unknown>;
  ipAddress: string | null;
  occurredAt: string;
}

/**
 * Who did what, when (PRD AUD-01). Read-only: nobody, including admins, can
 * change or delete entries. Details never include note text or contact details.
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("audit:read");
  const params = await searchParams;
  const action = AUDIT_ACTIONS.find((a) => a === one(params.action));
  const page = Math.max(0, Number(one(params.page)) || 0);
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (action) q.set("action", action);
  const data = await apiFetch<{ items: AuditRow[]; hasMore: boolean }>(`/audit-events?${q}`);
  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({ ...(action ? { action } : {}), ...next });
    for (const [k, v] of [...p]) if (!v || (k === "page" && v === "0")) p.delete(k);
    return `/settings/audit${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader title="Audit log" description="Every sign-in, change, export and sensitive view, with who did it. Entries can't be edited or deleted." />
      <form action="/settings/audit" className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="audit-action" className="text-sm text-ink-muted">Show</label>
        <select id="audit-action" name="action" defaultValue={action ?? ""} className="min-h-10 rounded-lg border border-line-strong bg-surface px-2 text-sm">
          <option value="">Everything</option>
          {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{LABELS[a]}</option>)}
        </select>
        <button className="min-h-10 rounded-lg border border-line-strong px-3 text-sm hover:bg-surface-muted">Filter</button>
      </form>
      {data.items.length === 0 ? (
        <Card><EmptyState title="Nothing recorded for this filter" /></Card>
      ) : (
        <Card>
          <ol className="-my-2 divide-y divide-line">
            {data.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5 text-sm">
                <time dateTime={e.occurredAt} className="w-44 shrink-0 text-ink-subtle">{clinicTime(e.occurredAt, session.clinic.timezone)}</time>
                <span className="font-medium">{e.actor}</span>
                <span className={e.action === "login_failure" ? "text-critical" : "text-ink-muted"}>{LABELS[e.action] ?? e.action}</span>
                {e.entityType && <span className="text-xs text-ink-subtle">{e.entityType.replace(/_/g, " ")}</span>}
                {Object.keys(e.changeSummary).length > 0 && (
                  <details className="w-full">
                    <summary className="cursor-pointer text-xs text-brand">Details</summary>
                    <pre className="mt-1 overflow-x-auto rounded-md bg-surface-muted p-2 text-xs">{JSON.stringify(e.changeSummary, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}
      <div className="mt-4 flex justify-between text-sm">
        {page > 0 ? <Link href={link({ page: String(page - 1) })} className="text-brand">← Newer</Link> : <span />}
        {data.hasMore && <Link href={link({ page: String(page + 1) })} className="text-brand">Older →</Link>}
      </div>
    </>
  );
}
