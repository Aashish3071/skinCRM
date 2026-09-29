import Link from "next/link";
import type { NoteFeedItem } from "@skincrm/contracts";
import { FeedFilters } from "@/components/feed-filters";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { clinicClock, clinicTime, groupByDay, groupByKey, initials } from "@/lib/format";
import { FeedGroup } from "@/components/feed-group";
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
  const from = one(params.from) ?? "";
  const to = one(params.to) ?? "";
  const view = one(params.view) === "patient" ? "patient" : "date";
  const personId = one(params.personId);
  const personName = one(params.personName) ?? "This patient";
  const count = Math.min(400, Math.max(PAGE, Number(one(params.count)) || PAGE));

  const query = new URLSearchParams({ limit: String(Math.min(count, 100)) });
  if (search) query.set("search", search);
  if (show === "pinned") query.set("pinned", "true");
  if (show === "mine") query.set("mine", "true");
  if (personId) query.set("personId", personId);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const feed = await getNoteFeed(query.toString());
  const tz = session.clinic.timezone;

  const href = (next: Record<string, string>) => {
    const q = new URLSearchParams({ ...(search ? { search } : {}), ...(show !== "all" ? { show } : {}), ...(personId ? { personId, personName } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(view !== "date" ? { view } : {}), ...next });
    for (const [k, v] of [...q]) if (!v || v === "all") q.delete(k);
    return `/notes${q.size ? `?${q}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Notes" description="What your team has written about each patient. Notes follow the patient everywhere in the CRM." />

      <FeedFilters
        searchLabel="Search notes"
        resultLabel={`${feed.items.length}${feed.hasMore ? "+" : ""} ${feed.items.length === 1 ? "note" : "notes"}`}
        values={{
          search,
          patient: personId ? { id: personId, name: personName } : null,
          selects: [
            { name: "show", label: "Show", value: show, options: [{ value: "all", label: "All notes" }, { value: "pinned", label: "Pinned only" }, { value: "mine", label: "Written by me" }] },
          ],
          from,
          to,
          groupBy: { name: "view", label: "Group by", value: view, options: [{ value: "date", label: "Day" }, { value: "patient", label: "Patient" }] },
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="order-2 min-w-0 lg:order-1">
          {feed.items.length === 0 ? (
            <Card>
              <EmptyState title={search ? `No notes mention “${search}”` : "No notes match these filters"}>
                Widen the date range or remove a filter above.
              </EmptyState>
            </Card>
          ) : (
            <div className="flex flex-col gap-6">
              {view === "patient"
                ? groupByKey(feed.items, (n) => n.personId).map((group) => (
                    <FeedGroup key={group.key} title={group.items[0]!.personName} href={`/people/${group.key}`} count={group.items.length} noun={["note", "notes"]}>
                      <NoteItems notes={group.items} timezone={tz} byPatient />
                    </FeedGroup>
                  ))
                : groupByDay(feed.items, (n) => n.createdAt, tz).map((group) => (
                    <FeedGroup key={group.day} title={group.day} count={group.items.length} noun={["note", "notes"]}>
                      <NoteItems notes={group.items} timezone={tz} />
                    </FeedGroup>
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

function NoteItems({ notes, timezone, byPatient = false }: { notes: NoteFeedItem[]; timezone: string; byPatient?: boolean }) {
  return <ul className="flex flex-col gap-2">{notes.map((note) => (
    <li key={note.id} className="rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-3">
        {!byPatient && <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">{initials(note.personName)}</span>}
        <div className="min-w-0 flex-1">
          {(!byPatient || note.pinned) && <div className="flex flex-wrap items-center gap-2">{!byPatient && <Link href={`/people/${note.personId}`} className="font-semibold hover:text-brand">{note.personName}</Link>}{note.pinned && <Badge tone="caution">Pinned</Badge>}</div>}
          <p className={`${byPatient && !note.pinned ? "" : "mt-1 "}whitespace-pre-wrap break-words text-[15px] leading-relaxed`}>{note.body}</p>
          <p className="mt-2 text-xs text-ink-subtle">{note.isMine ? "You" : (note.authorLabel ?? "Someone")} · {byPatient ? clinicTime(note.createdAt, timezone) : clinicClock(note.createdAt, timezone)}{note.editedAt && " · edited"}</p>
        </div>
      </div>
    </li>
  ))}</ul>;
}
