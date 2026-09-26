import Link from "next/link";
import type { ComponentType } from "react";
import { ACTIVITY_GROUPS, type ActivityGroup } from "@skincrm/contracts";
import {
  ActivityIcon,
  CalendarIcon,
  ChatIcon,
  FlagIcon,
  NotesIcon,
  PhoneIcon,
  TaskIcon,
} from "@/components/icons";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { clinicClock, groupByDay } from "@/lib/format";
import { requireCapability } from "@/lib/session";
import { getActivityFeed } from "@/lib/workspace";
import { PatientFilter } from "./patient-filter";

export const metadata = { title: "Activity — SkinCRM" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PAGE = 50;

const TYPE_ICON: Record<string, ComponentType<{ size?: number }>> = {
  call: PhoneIcon,
  email_sent: ChatIcon,
  email_received: ChatIcon,
  whatsapp_sent: ChatIcon,
  whatsapp_received: ChatIcon,
  appointment_created: CalendarIcon,
  appointment_changed: CalendarIcon,
  note: NotesIcon,
  stage_change: FlagIcon,
  assignment_change: FlagIcon,
  task_created: TaskIcon,
  task_completed: TaskIcon,
};

/**
 * What happened, across every patient, newest first. Two questions answered
 * with one tap each: "what did I do today?" (Just me) and "what's happened
 * with this patient?" (pick them).
 */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("leads:read");
  const params = await searchParams;
  const mine = one(params.who) === "me";
  const group = (Object.keys(ACTIVITY_GROUPS) as ActivityGroup[]).find((g) => g === one(params.group));
  const personId = one(params.personId);
  const personName = one(params.personName) ?? "This patient";
  const count = Math.min(100, Math.max(PAGE, Number(one(params.count)) || PAGE));

  const query = new URLSearchParams({ limit: String(count) });
  if (mine) query.set("mine", "true");
  if (group) query.set("group", group);
  if (personId) query.set("personId", personId);
  const feed = await getActivityFeed(query.toString());
  const tz = session.clinic.timezone;

  const href = (next: Record<string, string>) => {
    const base: Record<string, string> = {
      ...(mine ? { who: "me" } : {}),
      ...(group ? { group } : {}),
      ...(personId ? { personId, personName } : {}),
    };
    const q = new URLSearchParams({ ...base, ...next });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return `/activity${q.size ? `?${q}` : ""}`;
  };

  const chip = (active: boolean) =>
    `flex min-h-9 items-center whitespace-nowrap rounded-full border px-3.5 text-sm ${
      active ? "border-brand bg-brand-soft font-medium text-brand" : "border-line-strong text-ink-muted hover:bg-surface-muted"
    }`;

  return (
    <>
      <PageHeader title="Activity" description="Calls, messages, appointments and changes — everything that happened with your patients." />

      <div className="mb-5 flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div role="group" aria-label="Whose activity" className="inline-flex self-start rounded-lg border border-line-strong p-0.5">
            <Link href={href({ who: "" })} aria-current={!mine ? "true" : undefined} className={`flex min-h-9 items-center rounded-md px-3 text-sm ${!mine ? "bg-brand-soft font-medium text-brand" : "text-ink-muted"}`}>
              Everyone
            </Link>
            <Link href={href({ who: "me" })} aria-current={mine ? "true" : undefined} className={`flex min-h-9 items-center rounded-md px-3 text-sm ${mine ? "bg-brand-soft font-medium text-brand" : "text-ink-muted"}`}>
              Just me
            </Link>
          </div>
          <div className="flex-1 sm:max-w-sm">
            <PatientFilter current={personId ? { id: personId, name: personName } : null} />
          </div>
        </div>
        <nav aria-label="Kind of activity" className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            <li>
              <Link href={href({ group: "" })} className={chip(!group)} aria-current={!group ? "true" : undefined}>
                Everything
              </Link>
            </li>
            {(Object.entries(ACTIVITY_GROUPS) as [ActivityGroup, { label: string }][]).map(([key, value]) => (
              <li key={key}>
                <Link href={href({ group: key })} className={chip(group === key)} aria-current={group === key ? "true" : undefined}>
                  {value.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {feed.items.length === 0 ? (
        <Card>
          <EmptyState title="Nothing here">Try “Everything” or “Everyone”, or pick a different patient.</EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {groupByDay(feed.items, (a) => a.occurredAt, tz).map((day) => (
            <section key={day.day} aria-label={day.day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{day.day}</h2>
              <ol className="overflow-hidden rounded-card border border-line bg-surface">
                {day.items.map((item) => {
                  const Icon = TYPE_ICON[item.type] ?? ActivityIcon;
                  return (
                    <li key={item.id} className="flex gap-3 border-b border-line p-3 last:border-0 sm:p-4">
                      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-muted">
                        <Icon size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <Link href={item.leadId ? `/leads/${item.leadId}` : `/people/${item.personId}`} className="font-semibold hover:text-brand">
                            {item.personName}
                          </Link>
                          <span className="text-ink-muted"> — {item.summary}</span>
                        </p>
                        {item.body && <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink-muted">{item.body}</p>}
                        <p className="mt-1 text-xs text-ink-subtle">
                          {item.isMine ? "You" : (item.actorLabel === "system" ? "Automatic" : item.actorLabel ?? "Automatic")} · {clinicClock(item.occurredAt, tz)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {feed.hasMore && count < 100 && (
            <Link href={href({ count: String(count + PAGE) })} className="self-center text-sm font-medium text-brand">
              Show more
            </Link>
          )}
        </div>
      )}
    </>
  );
}
