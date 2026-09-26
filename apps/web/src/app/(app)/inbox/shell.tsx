import Link from "next/link";
import type { ConversationSummary, InboxView } from "@skincrm/contracts";
import { SearchIcon } from "@/components/icons";
import { initials, relativeTime } from "@/lib/format";
import type { InboxList } from "@/lib/inbox";
import { SimulateButton } from "./simulate";

const VIEWS: { key: InboxView; label: string; count?: keyof InboxList["counts"] }[] = [
  { key: "open", label: "Open", count: "open" },
  { key: "mine", label: "Mine", count: "mine" },
  { key: "unassigned", label: "Unassigned", count: "unassigned" },
  { key: "done", label: "Done" },
];

/**
 * Two panes on a desktop: the conversation list and the open thread. On a
 * phone only one shows at a time — the list, or the thread with a back
 * button — so neither is squeezed.
 */
export function InboxShell({
  list,
  view,
  search,
  selectedId,
  children,
}: {
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
    <div className="-mx-4 -mb-24 -mt-6 flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] border-line bg-surface md:mx-0 md:mb-0 md:mt-0 md:h-[calc(100dvh-4.5rem)] md:overflow-hidden md:rounded-card md:border">
      <section
        aria-label="Conversations"
        className={`${selectedId ? "hidden md:flex" : "flex"} w-full flex-col border-line md:w-80 md:shrink-0 md:border-r lg:w-96`}
      >
        <div className="border-b border-line p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">Inbox</h1>
            {list.simulateAvailable && <SimulateButton />}
          </div>
          <form role="search" action="/inbox" className="relative">
            {view !== "open" && <input type="hidden" name="view" value={view} />}
            <label htmlFor="inbox-search" className="sr-only">Search conversations</label>
            <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
            <input id="inbox-search" name="search" type="search" defaultValue={search} placeholder="Search name or number"
              className="min-h-10 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-ink-subtle" />
          </form>
          <nav aria-label="Filter" className="mt-2 -mx-3 overflow-x-auto px-3">
            <ul className="flex gap-1">
              {VIEWS.map((v) => (
                <li key={v.key}>
                  <Link href={`/inbox${q({ view: v.key })}`} aria-current={view === v.key ? "true" : undefined}
                    className={`flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] ${view === v.key ? "bg-brand-soft font-medium text-brand" : "text-ink-muted hover:bg-surface-muted"}`}>
                    {v.label}
                    {v.count && list.counts[v.count] > 0 && <span className="tabular-nums text-xs opacity-80">{list.counts[v.count]}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {list.items.length === 0 && (
            <li className="p-6 text-center text-sm text-ink-muted">
              {view === "done" ? "No finished conversations." : search ? "Nobody matches that search." : "No conversations here. New WhatsApp messages appear as they arrive."}
            </li>
          )}
          {list.items.map((c) => <Row key={c.id} c={c} active={c.id === selectedId} href={`/inbox/${c.id}${q({})}`} />)}
        </ul>
      </section>

      <section aria-label="Conversation" className={`${selectedId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {children}
      </section>
    </div>
  );
}

function Row({ c, active, href }: { c: ConversationSummary; active: boolean; href: string }) {
  const unread = c.unreadCount > 0;
  return (
    <li>
      <Link href={href} aria-current={active ? "page" : undefined}
        className={`flex gap-3 border-b border-line px-3 py-3 ${active ? "bg-brand-soft" : "hover:bg-surface-muted"}`}>
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-sm font-semibold text-ink-muted">
          {initials(c.personName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate ${unread ? "font-semibold" : "font-medium"}`}>{c.personName}</span>
            {c.lastMessageAt && <span className="shrink-0 text-xs text-ink-subtle">{relativeTime(c.lastMessageAt)}</span>}
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className={`truncate text-sm ${unread ? "text-ink" : "text-ink-muted"}`}>
              {c.lastDirection === "outbound" && "You: "}{c.lastPreview ?? "…"}
            </span>
            {unread && <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold text-on-brand" aria-label={`${c.unreadCount} unread`}>{c.unreadCount}</span>}
          </span>
          <span className="block truncate text-xs text-ink-subtle">{c.assignedName ? `With ${c.assignedName}` : "Unassigned"}</span>
        </span>
      </Link>
    </li>
  );
}
