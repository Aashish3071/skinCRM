"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import type { CalendarOptions } from "@/lib/calendar-view";

/**
 * One compact row: previous / Today / next, the date range, Day or Week, and
 * whose diary. Filters apply the moment they change — no "Apply" button.
 * Rarely used filters (branch, cancelled) sit behind "More".
 */
export function CalendarToolbar({
  title,
  prevHref,
  nextHref,
  todayHref,
  view,
  options,
  staffId,
  branchId,
  includeCanceled,
}: {
  title: string;
  prevHref: string;
  nextHref: string;
  todayHref: string;
  view: "day" | "week";
  options: CalendarOptions;
  staffId: string;
  branchId: string;
  includeCanceled: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next}`);
  };
  const iconBtn = "flex h-10 w-10 items-center justify-center rounded-lg border border-line-strong bg-surface hover:bg-surface-muted";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5">
        <Link href={prevHref} aria-label={`Previous ${view}`} className={iconBtn}>
          <ChevronLeftIcon size={18} />
        </Link>
        <Link href={todayHref} className="flex h-10 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium hover:bg-surface-muted">
          Today
        </Link>
        <Link href={nextHref} aria-label={`Next ${view}`} className={iconBtn}>
          <ChevronRightIcon size={18} />
        </Link>
      </div>
      <h2 className="min-w-0 flex-1 basis-40 text-lg font-semibold tracking-tight">{title}</h2>

      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <div role="group" aria-label="View" className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
          {(["day", "week"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={view === mode}
              onClick={() => set("view", mode)}
              className={`min-h-9 rounded-md px-3 text-sm capitalize ${view === mode ? "bg-brand-soft font-medium text-brand" : "text-ink-muted"}`}
            >
              {mode}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="cal-staff">
          Whose diary
        </label>
        <select
          id="cal-staff"
          value={staffId}
          onChange={(e) => set("staffUserId", e.target.value)}
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 text-sm sm:flex-none"
        >
          <option value="">Everyone</option>
          {options.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </select>
        <details className="relative">
          <summary className="flex min-h-10 cursor-pointer list-none items-center rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink-muted hover:bg-surface-muted">
            More
          </summary>
          <div className="absolute right-0 z-30 mt-1 flex w-64 flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-pop)]">
            {options.branches.length > 1 && (
              <label className="text-sm">
                Branch
                <select value={branchId} onChange={(e) => set("branchId", e.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm">
                  <option value="">All branches</option>
                  {options.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeCanceled} onChange={(e) => set("includeCanceled", e.target.checked ? "true" : "")} />
              Show cancelled and moved
            </label>
            <label className="text-sm">
              Jump to a date
              <input type="date" onChange={(e) => e.target.value && set("date", e.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm" />
            </label>
          </div>
        </details>
      </div>
    </div>
  );
}
