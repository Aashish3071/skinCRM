import { apiFetch } from "@/lib/api";
import { DeliveryReview, type Receipt } from "./delivery-review";
import Link from "next/link";
import { SUPPRESSION_REASON_LABELS, type MessageDto } from "@skincrm/contracts";
import { ChatIcon, MailIcon } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { clinicTime, relativeTime } from "@/lib/format";
import { getMessages } from "@/lib/messaging";
import { can, requireCapability } from "@/lib/session";

export const metadata = { title: "Sent messages — SkinCRM" };

type Search = Record<string, string | string[] | undefined>;
const PAGE = 30;

/**
 * Every message the CRM sent, or deliberately did not (PRD MSG-07).
 *
 * The "Not sent" filter is the one clinics need most: it answers "why didn't
 * my client get the reminder?" in plain English, one row per message.
 */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "suppressed", label: "Not sent" },
  { key: "failed", label: "Failed" },
] as const;

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("templates:read");
  const receipts = can(session, "templates:write") ? (await apiFetch<{ items: Receipt[] }>("/messages/delivery-review")).items : [];
  const params = await searchParams;
  const state = FILTERS.find((f) => f.key === params.state)?.key ?? "all";
  const channel = params.channel === "email" || params.channel === "whatsapp" ? params.channel : "";
  const page = Math.max(0, Number(params.page ?? 0) || 0);

  const query = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), direction: "outbound" });
  if (state !== "all") query.set("state", state);
  if (channel) query.set("channel", channel);
  const { items, totalCount } = await getMessages(query.toString());

  const link = (next: Record<string, string>) => {
    const q = new URLSearchParams({ ...(state !== "all" ? { state } : {}), ...(channel ? { channel } : {}), ...next });
    for (const [k, v] of [...q]) if (!v || v === "all" || (k === "page" && v === "0")) q.delete(k);
    return `/automations/messages${q.size ? `?${q}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Sent messages" description="Every email and WhatsApp the CRM sent — and, if one didn't go, why." />

      <DeliveryReview receipts={receipts} timezone={session.clinic.timezone} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5" role="group" aria-label="Status">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={link({ state: f.key, page: "0" })}
              aria-current={state === f.key ? "true" : undefined}
              className={`flex min-h-9 items-center rounded-md px-3 text-sm ${state === f.key ? "bg-brand-soft font-medium text-brand" : "text-ink-muted hover:text-ink"}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5" role="group" aria-label="Channel">
          {[
            ["", "Any"],
            ["email", "Email"],
            ["whatsapp", "WhatsApp"],
          ].map(([value, label]) => (
            <Link
              key={value}
              href={link({ channel: value!, page: "0" })}
              aria-current={channel === value ? "true" : undefined}
              className={`flex min-h-9 items-center rounded-md px-3 text-sm ${channel === value ? "bg-brand-soft font-medium text-brand" : "text-ink-muted hover:text-ink"}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <span className="ml-auto text-sm text-ink-muted">{totalCount} total</span>
      </div>

      {items.length === 0 ? (
        <Card>
          <EmptyState title="Nothing here yet">Messages appear as soon as an automation or a person sends one.</EmptyState>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((m) => (
            <MessageRow key={m.id} message={m} timezone={session.clinic.timezone} />
          ))}
        </ul>
      )}

      {(page > 0 || (page + 1) * PAGE < totalCount) && (
        <div className="mt-4 flex justify-between text-sm">
          {page > 0 ? <Link href={link({ page: String(page - 1) })} className="text-brand">← Newer</Link> : <span />}
          {(page + 1) * PAGE < totalCount && <Link href={link({ page: String(page + 1) })} className="text-brand">Older →</Link>}
        </div>
      )}
    </>
  );
}

const STATE: Record<string, { tone: "positive" | "critical" | "caution" | "neutral" | "brand"; label: string }> = {
  sent: { tone: "positive", label: "Sent" },
  delivered: { tone: "positive", label: "Delivered" },
  read: { tone: "positive", label: "Read" },
  suppressed: { tone: "caution", label: "Not sent" },
  failed: { tone: "critical", label: "Failed" },
  bounced: { tone: "critical", label: "Bounced" },
  sending: { tone: "brand", label: "Sending" },
  scheduled: { tone: "neutral", label: "Scheduled" },
  queued: { tone: "neutral", label: "Queued" },
  canceled: { tone: "neutral", label: "Cancelled" },
  draft: { tone: "neutral", label: "Draft" },
};

function MessageRow({ message: m, timezone }: { message: MessageDto; timezone: string }) {
  const Icon = m.channel === "email" ? MailIcon : ChatIcon;
  const state = STATE[m.state] ?? { tone: "neutral" as const, label: m.state };
  const why = m.suppressionReason ? SUPPRESSION_REASON_LABELS[m.suppressionReason] : m.failureDetail;
  const title = m.renderedSubject ?? m.templateName ?? m.renderedBody?.split("\n")[0] ?? (m.channel === "email" ? "Email" : "WhatsApp message");

  return (
    <li>
      <details className="group rounded-card border border-line bg-surface">
        <summary className="flex cursor-pointer list-none items-start gap-3 p-3 sm:items-center sm:p-4">
          <span aria-hidden="true" className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted sm:mt-0">
            <Icon size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{m.personName ?? "Unknown"} · <span className="font-normal text-ink-muted">{title}</span></span>
            <span className="block text-xs text-ink-subtle">
              {m.ruleName ? `By automation “${m.ruleName}”` : "Sent by staff"} · <time dateTime={m.createdAt} title={clinicTime(m.createdAt, timezone)}>{relativeTime(m.createdAt)}</time>
            </span>
            {why && m.state !== "sent" && <span className="mt-1 block text-xs text-caution">{why}</span>}
          </span>
          <Badge tone={state.tone}>{state.label}</Badge>
        </summary>
        <div className="border-t border-line p-4 text-sm">
          <dl className="mb-3 grid gap-x-4 gap-y-1 text-xs text-ink-muted sm:grid-cols-[auto_1fr]">
            <dt>To</dt>
            <dd className="text-ink">{m.recipient ?? "No address on file"}</dd>
            <dt>Kind</dt>
            <dd className="text-ink">{m.classification === "promotional" ? "Marketing" : "Service"}</dd>
            {m.templateName && (
              <>
                <dt>Template</dt>
                <dd className="text-ink">{m.templateName} (v{m.templateVersion})</dd>
              </>
            )}
          </dl>
          {m.renderedBody ? (
            <p className="whitespace-pre-wrap rounded-lg bg-surface-muted p-3 leading-relaxed">{m.renderedBody}</p>
          ) : (
            <p className="text-ink-muted">The message wasn&rsquo;t written out because it was never sent.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-4">
            <Link href={`/people/${m.personId}`} className="text-brand">Open person</Link>
            {m.leadId && <Link href={`/leads/${m.leadId}`} className="text-brand">Open lead</Link>}
            {m.ruleId && <Link href={`/automations/${m.ruleId}`} className="text-brand">Open automation</Link>}
          </div>
        </div>
      </details>
    </li>
  );
}
