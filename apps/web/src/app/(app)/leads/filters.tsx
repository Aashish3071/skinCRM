"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, type SavedViewDto } from "@skincrm/contracts";
import { SearchIcon } from "@/components/icons";
import { buttonClasses, inputClasses } from "@/components/ui";
import { ViewsMenu } from "./views-menu";

/** URL parameters that make up a view. Anything else (offset…) is not saved. */
export const VIEW_KEYS = ["search", "mine", "unassigned", "view", "source", "stage", "awaiting", "from", "to"] as const;

/**
 * The leads toolbar: search, whose leads, board or list, a fold-out of extra
 * filters, and saved views. Everything lives in the URL, so a view survives a
 * refresh, can be shared, and a saved view is exactly that URL.
 */
export function LeadFilters({
  view,
  canSeeAll,
  stages,
  views,
  isAdmin,
}: {
  view: "list" | "board";
  canSeeAll: boolean;
  stages: { id: string; name: string }[];
  views: SavedViewDto[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const extraCount = ["source", "stage", "awaiting", "from", "to"].filter((k) => params.get(k)).length;
  const [more, setMore] = useState(extraCount > 0);

  const push = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    next.delete("offset");
    router.push(`${pathname}?${next.toString()}`);
  };

  const owner = params.get("unassigned") === "true" ? "unassigned" : params.get("mine") === "true" ? "mine" : "all";
  const current: Record<string, string> = {};
  for (const key of VIEW_KEYS) {
    const value = params.get(key);
    if (value) current[key] = value;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <form
          role="search"
          className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-xs"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("search")?.toString().trim() ?? "";
            push((next) => (value ? next.set("search", value) : next.delete("search")));
          }}
        >
          <label htmlFor="lead-search" className="sr-only">
            Search leads
          </label>
          <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            id="lead-search"
            name="search"
            type="search"
            defaultValue={params.get("search") ?? ""}
            placeholder="Search name, phone or email"
            className="min-h-10 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-ink-subtle"
          />
        </form>

        {canSeeAll && (
          <Segmented
            label="Whose leads"
            value={owner}
            options={[
              { value: "all", label: "Everyone" },
              { value: "mine", label: "Mine" },
              { value: "unassigned", label: "Unassigned" },
            ]}
            onChange={(value) =>
              push((next) => {
                next.delete("mine");
                next.delete("unassigned");
                if (value !== "all") next.set(value, "true");
              })
            }
          />
        )}

        <button
          type="button"
          aria-expanded={more}
          aria-controls="lead-more-filters"
          onClick={() => setMore((v) => !v)}
          className={buttonClasses("secondary", "sm")}
        >
          More filters{extraCount ? ` (${extraCount})` : ""}
        </button>

        <ViewsMenu views={views} current={current} isAdmin={isAdmin} />

        <div className="ml-auto">
          <Segmented
            label="View"
            value={view}
            options={[
              { value: "board", label: "Board" },
              { value: "list", label: "List" },
            ]}
            onChange={(value) => push((next) => (value === "board" ? next.delete("view") : next.set("view", value)))}
          />
        </div>
      </div>

      {more && (
        <form
          id="lead-more-filters"
          className="grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const from = String(f.get("from") ?? "");
            const to = String(f.get("to") ?? "");
            push((next) => {
              for (const key of ["source", "stage", "from", "to"]) {
                const value = String(f.get(key) ?? "");
                if (value) next.set(key, value);
                else next.delete(key);
              }
              if (from && to && from > to) {
                next.set("from", to);
                next.set("to", from);
              }
              if (f.get("awaiting") === "on") next.set("awaiting", "true");
              else next.delete("awaiting");
            });
          }}
        >
          <div>
            <label htmlFor="f-source" className="block text-sm font-medium">Source</label>
            <select id="f-source" name="source" defaultValue={params.get("source") ?? ""} className={`mt-1.5 ${inputClasses}`}>
              <option value="">Any source</option>
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{LEAD_SOURCE_LABELS[s]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-stage" className="block text-sm font-medium">Stage</label>
            <select id="f-stage" name="stage" defaultValue={params.get("stage") ?? ""} className={`mt-1.5 ${inputClasses}`}>
              <option value="">Any stage</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-from" className="block text-sm font-medium">Added from</label>
            <input id="f-from" name="from" type="date" defaultValue={params.get("from") ?? ""} className={`mt-1.5 ${inputClasses}`} />
          </div>
          <div>
            <label htmlFor="f-to" className="block text-sm font-medium">Added to</label>
            <input id="f-to" name="to" type="date" defaultValue={params.get("to") ?? ""} className={`mt-1.5 ${inputClasses}`} />
          </div>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="awaiting" defaultChecked={params.get("awaiting") === "true"} />
              Waiting for a first reply
            </label>
          </div>
          <div className="flex flex-wrap justify-end gap-2 sm:col-span-2 lg:col-span-5">
            {extraCount > 0 && (
              <button type="button" onClick={() => push((next) => { for (const k of ["source", "stage", "awaiting", "from", "to"]) next.delete(k); })} className={buttonClasses("ghost", "sm")}>
                Clear these
              </button>
            )}
            <button type="submit" className={buttonClasses("primary", "sm")}>Apply</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`min-h-9 rounded-md px-3 text-sm transition-colors ${
            value === option.value ? "bg-brand-soft font-medium text-brand" : "text-ink-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
