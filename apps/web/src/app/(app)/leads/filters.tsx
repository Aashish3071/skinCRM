"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "@/components/icons";

/**
 * The whole leads toolbar: search, whose leads, and board or list.
 *
 * Deliberately short. Stage is what the board's columns already show, and
 * source-level slicing belongs to Reports; putting both here made the most
 * used screen the most crowded one. Filters live in the URL so a view
 * survives a refresh and can be shared.
 */
export function LeadFilters({ view, canSeeAll }: { view: "list" | "board"; canSeeAll: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const push = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    next.delete("offset");
    router.push(`${pathname}?${next.toString()}`);
  };

  const owner = params.get("unassigned") === "true" ? "unassigned" : params.get("mine") === "true" ? "mine" : "all";

  return (
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
