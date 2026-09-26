"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "@skincrm/contracts";
import type { PipelineStage } from "@/lib/crm";

/**
 * Filters live in the URL rather than component state, so a filtered view can
 * be bookmarked, shared with a colleague and survives a refresh — which is what
 * "saved views" in PRD LEAD-07 will build on.
 */
export function LeadFilters({
  stages,
  staff,
  view,
}: {
  stages: PipelineStage[];
  staff: { id: string; fullName: string }[];
  view: "list" | "board";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === "") next.delete(key);
    else next.set(key, value);
    // Changing a filter should not leave you on page 4 of the old result set.
    next.delete("offset");
    router.push(`${pathname}?${next.toString()}`);
  };

  const current = (key: string) => params.get(key) ?? "";

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-surface px-4 py-3">
      <Filter label="Search" htmlFor="filter-search">
        <input
          id="filter-search"
          type="search"
          defaultValue={current("search")}
          placeholder="Name, phone or email"
          onKeyDown={(e) => {
            if (e.key === "Enter") set("search", (e.target as HTMLInputElement).value);
          }}
          onBlur={(e) => set("search", e.target.value)}
          className="w-52 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
        />
      </Filter>

      <Filter label="Stage" htmlFor="filter-stage">
        <select
          id="filter-stage"
          value={current("stageCategory")}
          onChange={(e) => set("stageCategory", e.target.value)}
          className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
        >
          <option value="">All stages</option>
          {stages.map((stage) => (
            <option key={stage.id} value={stage.category}>
              {stage.name}
            </option>
          ))}
        </select>
      </Filter>

      <Filter label="Source" htmlFor="filter-source">
        <select
          id="filter-source"
          value={current("source")}
          onChange={(e) => set("source", e.target.value)}
          className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
        >
          <option value="">All sources</option>
          {LEAD_SOURCES.map((source) => (
            <option key={source} value={source}>
              {LEAD_SOURCE_LABELS[source]}
            </option>
          ))}
        </select>
      </Filter>

      {staff.length > 0 && (
        <Filter label="Owner" htmlFor="filter-owner">
          <select
            id="filter-owner"
            value={current("unassigned") === "true" ? "__unassigned" : current("ownerUserId")}
            onChange={(e) => {
              const next = new URLSearchParams(params.toString());
              next.delete("ownerUserId");
              next.delete("unassigned");
              if (e.target.value === "__unassigned") next.set("unassigned", "true");
              else if (e.target.value !== "") next.set("ownerUserId", e.target.value);
              router.push(`${pathname}?${next.toString()}`);
            }}
            className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
          >
            <option value="">Anyone</option>
            <option value="__unassigned">Unassigned queue</option>
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.fullName}
              </option>
            ))}
          </select>
        </Filter>
      )}

      <label className="flex items-center gap-2 pb-1.5 text-sm">
        <input
          type="checkbox"
          checked={current("includeClosed") !== "false"}
          onChange={(e) => set("includeClosed", e.target.checked ? "" : "false")}
        />
        Show closed
      </label>

      <div className="ml-auto flex items-center gap-1 pb-0.5" role="group" aria-label="View">
        {(["list", "board"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => set("view", option === "list" ? "" : option)}
            className={`rounded-md px-2.5 py-1.5 text-sm capitalize ${
              view === option
                ? "bg-brand-soft font-medium text-brand"
                : "border border-line-strong hover:bg-surface-muted"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function Filter({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
