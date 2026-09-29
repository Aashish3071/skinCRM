import Link from "next/link";
import type { ComponentType } from "react";
import { ACTIVITY_GROUPS, type ActivityFeedItem, type ActivityGroup } from "@skincrm/contracts";
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
import { FeedFilters } from "@/components/feed-filters";
import { FeedGroup } from "@/components/feed-group";
import { clinicClock, clinicTime, groupByDay, groupByKey } from "@/lib/format";
import { requireCapability } from "@/lib/session";
import { getActivityFeed } from "@/lib/workspace";

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
  const from = one(params.from) ?? "";
  const to = one(params.to) ?? "";
  const view = one(params.view) === "patient" || one(params.view) === "lead" ? one(params.view)! : "date";
  const count = Math.min(100, Math.max(PAGE, Number(one(params.count)) || PAGE));

  const query = new URLSearchParams({ limit: String(count) });
  if (mine) query.set("mine", "true");
  if (group) query.set("group", group);
  if (personId) query.set("personId", personId);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const feed = await getActivityFeed(query.toString());
  const tz = session.clinic.timezone;

  const href = (next: Record<string, string>) => {
    const base: Record<string, string> = {
      ...(mine ? { who: "me" } : {}),
      ...(group ? { group } : {}),
      ...(personId ? { personId, personName } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(view !== "date" ? { view } : {}),
    };
    const q = new URLSearchParams({ ...base, ...next });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return `/activity${q.size ? `?${q}` : ""}`;
  };
  const shown = feed.items.length;

  return (
    <>
      <PageHeader title="Activity" description="Calls, messages, appointments and changes — everything that happened with your patients." />

      <FeedFilters
        resultLabel={`${shown}${feed.hasMore ? "+" : ""} ${shown === 1 ? "event" : "events"}`}
        values={{
          patient: personId ? { id: personId, name: personName } : null,
          selects: [
            { name: "who", label: "Done by", value: mine ? "me" : "", options: [{ value: "", label: "Everyone" }, { value: "me", label: "Just me" }] },
            {
              name: "group",
              label: "Kind",
              value: group ?? "",
              options: [{ value: "", label: "Everything" }, ...(Object.entries(ACTIVITY_GROUPS) as [ActivityGroup, { label: string }][]).map(([key, value]) => ({ value: key, label: value.label }))],
            },
          ],
          from,
          to,
          groupBy: { name: "view", label: "Group by", value: view, options: [{ value: "date", label: "Day" }, { value: "patient", label: "Patient" }, { value: "lead", label: "Inquiry / lead" }] },
        }}
      />

      {feed.items.length === 0 ? (
        <Card>
          <EmptyState title="No activity matches these filters">Widen the date range or remove a filter above.</EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {view === "date"
            ? groupByDay(feed.items, (a) => a.occurredAt, tz).map((day) => (
                <FeedGroup key={day.day} title={day.day} count={day.items.length} noun={["event", "events"]}>
                  <ActivityItems items={day.items} timezone={tz} />
                </FeedGroup>
              ))
            : groupByKey(feed.items, (a) => view === "lead" && a.leadId ? `lead:${a.leadId}` : `patient:${a.personId}`).map((section) => {
                const first = section.items[0]!;
                const isLead = view === "lead" && first.leadId;
                return (
                  <FeedGroup
                    key={section.key}
                    title={first.personName}
                    href={isLead ? `/leads/${first.leadId}` : `/people/${first.personId}`}
                    detail={view === "lead" ? (isLead ? `Inquiry${first.leadCreatedAt ? ` from ${clinicTime(first.leadCreatedAt, tz)}` : ""}` : "Patient record (no inquiry)") : undefined}
                    count={section.items.length}
                    noun={["event", "events"]}
                  >
                    <ActivityItems items={section.items} timezone={tz} grouped />
                  </FeedGroup>
                );
              })}
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

function ActivityItems({ items, timezone, grouped = false }: { items: ActivityFeedItem[]; timezone: string; grouped?: boolean }) {
  return <ol className="overflow-hidden rounded-card border border-line bg-surface">{items.map((item) => {
    const Icon = TYPE_ICON[item.type] ?? ActivityIcon;
    return <li key={item.id} className="flex gap-3 border-b border-line p-3 last:border-0 sm:p-4">
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-muted"><Icon size={16} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{grouped ? item.summary : <><Link href={item.leadId ? `/leads/${item.leadId}` : `/people/${item.personId}`} className="font-semibold hover:text-brand">{item.personName}</Link><span className="text-ink-muted"> — {item.summary}</span></>}</p>
        {item.body && <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink-muted">{item.body}</p>}
        <p className="mt-1 text-xs text-ink-subtle">{item.isMine ? "You" : (item.actorLabel === "system" ? "Automatic" : item.actorLabel ?? "Automatic")} · {grouped ? clinicTime(item.occurredAt, timezone) : clinicClock(item.occurredAt, timezone)}</p>
      </div>
    </li>;
  })}</ol>;
}
