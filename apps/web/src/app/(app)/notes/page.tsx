import Link from "next/link";
import { SearchIcon } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { clinicClock, groupByDay, initials } from "@/lib/format";
import { getNoteFeed } from "@/lib/workspace";
import { can, requireCapability } from "@/lib/session";
import { NoteComposer } from "./composer";

export const metadata = { title: "Notes — SkinCRM" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PAGE = 40;

/**
 * Every patient's General Notes in one place, newest first, under day
 * headings — read like a diary. Search covers the note text and the patient's
 * name, so "who mentioned the allergy?" is one search.
 */
export default async function NotesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("notes:read");
  const params = await searchParams;
  const search = one(params.search)?.trim() ?? "";
  const show = one(params.show) === "pinned" ? "pinned" : one(params.show) === "mine" ? "mine" : "all";
  const count = Math.min(400, Math.max(PAGE, Number(one(params.count)) || PAGE));

  const query = new URLSearchParams({ limit: String(Math.min(count, 100)) });
  if (search) query.set("search", search);
  if (show === "pinned") query.set("pinned", "true");
  if (show === "mine") query.set("mine", "true");
  const feed = await getNoteFeed(query.toString());
  const tz = session.clinic.timezone;

  const href = (next: Record<string, string>) => {
    const q = new URLSearchParams({ ...(search ? { search } : {}), ...(show !== "all" ? { show } : {}), ...next });
    for (const [k, v] of [...q]) if (!v || v === "all") q.delete(k);
    return `/notes${q.size ? `?${q}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Notes" description="What your team has written about each patient. Notes follow the patient everywhere in the CRM." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="order-2 min-w-0 lg:order-1">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <form role="search" action="/notes" className="relative flex-1">
              {show !== "all" && <input type="hidden" name="show" value={show} />}
              <label htmlFor="notes-search" className="sr-only">
                Search notes
              </label>
              <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input
                id="notes-search"
                name="search"
                type="search"
                defaultValue={search}
                placeholder="Search notes or patient names"
                className="min-h-10 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-ink-subtle"
              />
            </form>
            <div role="group" aria-label="Show" className="inline-flex self-start rounded-lg border border-line-strong bg-surface p-0.5">
              {[
                ["all", "All"],
                ["pinned", "Pinned"],
                ["mine", "Written by me"],
              ].map(([key, label]) => (
                <Link
                  key={key}
                  href={href({ show: key! })}
                  aria-current={show === key ? "true" : undefined}
                  className={`flex min-h-9 items-center whitespace-nowrap rounded-md px-3 text-sm ${
                    show === key ? "bg-brand-soft font-medium text-brand" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>

          {feed.items.length === 0 ? (
            <Card>
              <EmptyState title={search ? `No notes mention “${search}”` : "No notes yet"}>
                {search ? <Link href={href({ search: "" })} className="text-brand">Clear the search</Link> : "Write the first one using the box on this page."}
              </EmptyState>
            </Card>
          ) : (
            <div className="flex flex-col gap-6">
              {groupByDay(feed.items, (n) => n.createdAt, tz).map((group) => (
                <section key={group.day} aria-label={group.day}>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{group.day}</h2>
                  <ul className="flex flex-col gap-2">
                    {group.items.map((note) => (
                      <li key={note.id} className="rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)]">
                        <div className="flex items-start gap-3">
                          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
                            {initials(note.personName)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link href={`/people/${note.personId}`} className="font-semibold hover:text-brand">
                                {note.personName}
                              </Link>
                              {note.pinned && <Badge tone="caution">Pinned</Badge>}
                            </div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed">{note.body}</p>
                            <p className="mt-2 text-xs text-ink-subtle">
                              {note.isMine ? "You" : (note.authorLabel ?? "Someone")} · {clinicClock(note.createdAt, tz)}
                              {note.editedAt && " · edited"}
                            </p>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {feed.hasMore && count < 100 && (
                <Link href={href({ count: String(count + PAGE) })} className="self-center text-sm font-medium text-brand">
                  Show older notes
                </Link>
              )}
            </div>
          )}
        </div>

        {can(session, "notes:write") && (
          <aside className="order-1 lg:order-2">
            <Card title="Write a note">
              <NoteComposer initialPerson={null} />
            </Card>
          </aside>
        )}
      </div>
    </>
  );
}
