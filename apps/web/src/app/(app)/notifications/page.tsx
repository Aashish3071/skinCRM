import Link from "next/link";
import { BellIcon } from "@/components/icons";
import { NOTIFICATION_ICONS } from "@/components/notification-bell";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { clinicClock, groupByDay } from "@/lib/format";
import { loadNotificationsAction } from "@/lib/notification-actions";
import { requireSession } from "@/lib/session";
import { MarkAllRead } from "./mark-all";

export const metadata = { title: "Notifications — SkinCRM" };

export default async function NotificationsPage() {
  const session = await requireSession();
  const data = await loadNotificationsAction(100);
  const tz = session.clinic.timezone;
  return (
    <>
      <PageHeader
        title="Notifications"
        description="New leads, appointments, tasks and messages that need you. Choose which ones you get in My profile."
        actions={data.unreadCount > 0 ? <MarkAllRead /> : null}
      />
      {data.items.length === 0 ? (
        <Card><EmptyState title="Nothing yet" /></Card>
      ) : (
        <div className="flex flex-col gap-6">
          {groupByDay(data.items, (n) => n.createdAt, tz).map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{g.day}</h2>
              <ul className="overflow-hidden rounded-card border border-line bg-surface">
                {g.items.map((n) => {
                  const Icon = NOTIFICATION_ICONS[n.type] ?? BellIcon;
                  const inner = (
                    <span className="flex gap-3 px-4 py-3">
                      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><Icon size={17} /></span>
                      <span className="min-w-0 flex-1">
                        <span className={`block ${n.read ? "" : "font-semibold"}`}>{n.title}</span>
                        {n.body && <span className="block text-sm text-ink-muted">{n.body}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-ink-subtle">{clinicClock(n.createdAt, tz)}</span>
                    </span>
                  );
                  return (
                    <li key={n.id} className={`border-b border-line last:border-0 ${n.read ? "" : "bg-brand-soft/40"}`}>
                      {n.link ? <Link href={n.link} className="block hover:bg-surface-muted">{inner}</Link> : inner}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p className="mt-6 text-sm text-ink-muted"><Link href="/settings/profile#notifications" className="text-brand">Choose which notifications you get</Link></p>
    </>
  );
}
