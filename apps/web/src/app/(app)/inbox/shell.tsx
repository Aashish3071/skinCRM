import Link from "next/link";
import type { ConversationSummary, InboxView } from "@skincrm/contracts";
import { SearchIcon } from "@/components/icons";
import { initials } from "@/lib/format";
import type { InboxList } from "@/lib/inbox";
import { SimulateButton } from "./simulate";

const VIEWS: { key: InboxView; label: string; count?: keyof InboxList["counts"] }[] = [
  { key: "open", label: "All" },
  { key: "unread", label: "Unread", count: "unread" },
  { key: "mine", label: "Mine", count: "mine" },
  { key: "unassigned", label: "Unassigned", count: "unassigned" },
  { key: "done", label: "Done" },
];

/**
 * The inbox, laid out like WhatsApp: chats on the left, the open chat on the
 * right. On a phone, one at a time — exactly like the WhatsApp app — so staff
 * already know how to use it.
 */
export function InboxShell({ list, view, search, selectedId, children }: {
  list: InboxList;
  view: InboxView;
  search: string;
  selectedId: string | null;
  children: React.ReactNode;
}) {
  const q = (next: Record<string, string>) => {
    const p = new URLSearchParams({ ...(view !== "open" ? { view } : {}), ...(search ? { search } : {}), ...next });
    for (const [k, v] of [...p]) if (!v || (k === "view" && v === "open")) p.delete(k);
    return p.size ? `?${p}` : "";
  };

  return (
    <div className="-mx-4 -mb-24 -mt-6 flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] text-[var(--wa-text)] md:mx-0 md:mb-0 md:mt-0 md:h-[calc(100dvh-4.5rem)] md:overflow-hidden md:rounded-card md:border md:border-line md:shadow-[var(--shadow-card)]">
      <section aria-label="Chats" className={`${selectedId ? "hidden md:flex" : "flex"} w-full flex-col bg-[var(--wa-list)] md:w-[340px] md:shrink-0 md:border-r md:border-line lg:w-[400px]`}>
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 bg-[var(--wa-panel)] px-4">
          <h1 className="text-xl font-semibold">Chats</h1>
          {list.simulateAvailable && <SimulateButton />}
        </header>
        <div className="px-3 pb-2 pt-2">
          <form role="search" action="/inbox" className="relative">
            {view !== "open" && <input type="hidden" name="view" value={view} />}
            <label htmlFor="inbox-search" className="sr-only">Search chats</label>
            <SearchIcon size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--wa-meta)]" />
            <input id="inbox-search" name="search" type="search" defaultValue={search} placeholder="Search name or number"
              className="h-10 w-full rounded-lg border-0 bg-[var(--wa-panel)] pl-11 pr-3 text-sm text-[var(--wa-text)] placeholder:text-[var(--wa-meta)]" />
          </form>
          <nav aria-label="Filter chats" className="-mx-3 mt-2 overflow-x-auto px-3">
            <ul className="flex gap-2">
              {VIEWS.map((v) => {
                const active = view === v.key;
                const n = v.count ? list.counts[v.count] : 0;
                return (
                  <li key={v.key}>
                    <Link href={`/inbox${q({ view: v.key })}`} aria-current={active ? "true" : undefined}
                      className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] ${
                        active ? "bg-[#d9fdd3] font-medium text-[#0a5c36] dark:bg-[#103529] dark:text-[#25d366]" : "bg-[var(--wa-panel)] text-[var(--wa-meta)] hover:text-[var(--wa-text)]"
                      }`}>
                      {v.label}
                      {n > 0 && <span className="tabular-nums">{n}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {list.items.length === 0 && (
            <li className="px-6 py-10 text-center text-sm text-[var(--wa-meta)]">
              {search ? "No chats match that search." : view === "done" ? "No finished chats." : "No chats yet. New WhatsApp messages appear here as they arrive."}
            </li>
          )}
          {list.items.map((c) => <Row key={c.id} c={c} active={c.id === selectedId} href={`/inbox/${c.id}${q({})}`} />)}
        </ul>
      </section>

      <section aria-label="Chat" className={`${selectedId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {children}
      </section>
    </div>
  );
}

/** Time like WhatsApp: clock time today, "Yesterday", weekday this week, then a date. */
function listTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
}

export function Avatar({ name, size = 48 }: { name: string; size?: number }) {
  // A stable colour per name, from a small palette that reads in both themes.
  const palette = ["#dfe5e7", "#cfe9e4", "#f1d9d4", "#dde3f5", "#f4e7c8", "#e3d9f1"];
  const colour = palette[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length];
  return (
    <span aria-hidden="true" style={{ width: size, height: size, background: colour }}
      className="flex shrink-0 items-center justify-center rounded-full text-sm font-semibold text-[#3b4a54]">
      {initials(name) || "?"}
    </span>
  );
}

function Row({ c, active, href }: { c: ConversationSummary; active: boolean; href: string }) {
  const unread = c.unreadCount > 0;
  return (
    <li>
      <Link href={href} aria-current={active ? "page" : undefined}
        className={`flex items-center gap-3 pl-3 ${active ? "bg-[var(--wa-list-active)]" : "hover:bg-[var(--wa-list-hover)]"}`}>
        <Avatar name={c.personName} />
        <span className="flex min-w-0 flex-1 flex-col justify-center border-b border-line py-3 pr-4">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[16px]">{c.personName}</span>
            {c.lastMessageAt && (
              <span className={`shrink-0 text-xs ${unread ? "font-medium text-[var(--wa-green)]" : "text-[var(--wa-meta)]"}`}>{listTime(c.lastMessageAt)}</span>
            )}
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className={`truncate text-sm ${unread ? "text-[var(--wa-text)]" : "text-[var(--wa-meta)]"}`}>
              {c.lastDirection === "outbound" && <span aria-label="You:">✓ </span>}
              {c.lastPreview ?? ""}
            </span>
            {unread ? (
              <span aria-label={`${c.unreadCount} unread`} className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--wa-green-bright)] px-1.5 text-[11px] font-semibold text-[#0b141a]">
                {c.unreadCount}
              </span>
            ) : (
              !c.assignedName && c.status !== "resolved" && <span className="shrink-0 text-[11px] text-[var(--wa-meta)]">Unassigned</span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}
