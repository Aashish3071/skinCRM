"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { NotificationType } from "@skincrm/contracts";
import { loadNotificationsAction, markAllReadAction, markReadAction, type NotificationItem } from "@/lib/notification-actions";
import { relativeTime } from "@/lib/format";
import { BellIcon, CalendarIcon, ChatIcon, ClockIcon, LeadsIcon, TaskIcon } from "./icons";

export const NOTIFICATION_ICONS: Record<NotificationType, ComponentType<{ size?: number }>> = {
  lead_new: LeadsIcon,
  lead_assigned: LeadsIcon,
  appointment_soon: CalendarIcon,
  task_due: TaskIcon,
  sla_missed: ClockIcon,
  whatsapp_message: ChatIcon,
};

/**
 * The bell: unread count on the button, the latest few in a panel. Checks for
 * new ones every 30 seconds while the page is open (and when you come back to
 * the tab), so nobody has to refresh.
 */
export function NotificationBell({ align = "left" }: { align?: "left" | "right" }) {
  const router = useRouter();
  const [data, setData] = useState<{ unreadCount: number; items: NotificationItem[] }>({ unreadCount: 0, items: [] });
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => setData(await loadNotificationsAction(12)), []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") { setOpen(false); button.current?.focus(); }
        return;
      }
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const openItem = async (n: NotificationItem) => {
    setOpen(false);
    if (!n.read) {
      setData((d) => ({ unreadCount: Math.max(0, d.unreadCount - 1), items: d.items.map((x) => (x.id === n.id ? { ...x, read: true } : x)) }));
      await markReadAction(n.id);
    }
    if (n.link) router.push(n.link);
  };

  const count = data.unreadCount;
  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => { setOpen(!open); if (!open) void refresh(); }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-surface-muted hover:text-ink"
      >
        <BellIcon size={20} />
        {count > 0 && (
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-critical px-1 text-[10px] font-bold text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Notifications"
          className={`absolute z-50 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow-pop)] ${align === "right" ? "right-0" : "left-0"}`}
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="font-semibold">Notifications</p>
            {count > 0 && (
              <button type="button" onClick={async () => { await markAllReadAction(); await refresh(); }} className="text-sm text-brand">
                Mark all as read
              </button>
            )}
          </div>
          {data.items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">Nothing yet. New leads, appointments and messages will show up here.</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {data.items.map((n) => {
                const Icon = NOTIFICATION_ICONS[n.type] ?? BellIcon;
                return (
                  <li key={n.id}>
                    <button type="button" onClick={() => void openItem(n)} className={`flex w-full gap-3 border-b border-line px-4 py-3 text-left hover:bg-surface-muted ${n.read ? "" : "bg-brand-soft/40"}`}>
                      <span aria-hidden="true" className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><Icon size={16} /></span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-sm ${n.read ? "" : "font-semibold"}`}>{n.title}</span>
                        {n.body && <span className="block truncate text-xs text-ink-muted">{n.body}</span>}
                        <span className="block text-xs text-ink-subtle">{relativeTime(n.createdAt)}</span>
                      </span>
                      {!n.read && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2.5 text-center text-sm font-medium text-brand hover:bg-surface-muted">
            See all
          </Link>
        </div>
      )}
    </div>
  );
}
