"use client";

import { usePathname, useRouter } from "next/navigation";

/** Date presets and a source filter. Custom dates sit behind "Custom". */
export function RangePicker({ from, to, source, timezone, sources }: {
  from: string; to: string; source: string; timezone: string; sources: { value: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: timezone });
  const today = day(0);
  const monthStart = `${today.slice(0, 8)}01`;
  const presets = [
    { label: "7 days", from: day(-6), to: today },
    { label: "30 days", from: day(-29), to: today },
    { label: "90 days", from: day(-89), to: today },
    { label: "This month", from: monthStart, to: today },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];
  const go = (next: { from?: string; to?: string; source?: string }) => {
    const q = new URLSearchParams({ from: next.from ?? from, to: next.to ?? to });
    const s = next.source ?? source;
    if (s) q.set("source", s);
    router.push(`${pathname}?${q}`);
  };
  const active = presets.find((p) => p.from === from && p.to === to);

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Period" className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {presets.map((p) => (
          <button key={p.label} type="button" aria-pressed={active === p} onClick={() => go(p)}
            className={`min-h-9 shrink-0 rounded-full border px-3.5 text-sm ${active === p ? "border-brand bg-brand-soft font-medium text-brand" : "border-line-strong text-ink-muted hover:bg-surface-muted"}`}>
            {p.label}
          </button>
        ))}
      </div>
      <details className="relative">
        <summary className={`flex min-h-9 cursor-pointer list-none items-center rounded-full border px-3.5 text-sm ${!active ? "border-brand bg-brand-soft font-medium text-brand" : "border-line-strong text-ink-muted"}`}>
          {active ? "Custom" : `${from} → ${to}`}
        </summary>
        <form className="absolute z-30 mt-1 flex w-72 flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-pop)]"
          onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); go({ from: String(f.get("from")), to: String(f.get("to")) }); }}>
          <label className="text-sm">From<input type="date" name="from" defaultValue={from} required className="mt-1 min-h-10 w-full rounded-lg border border-line-strong bg-surface px-2" /></label>
          <label className="text-sm">To<input type="date" name="to" defaultValue={to} required className="mt-1 min-h-10 w-full rounded-lg border border-line-strong bg-surface px-2" /></label>
          <button className="min-h-10 rounded-lg bg-brand text-sm font-medium text-on-brand">Show</button>
        </form>
      </details>
      <label className="sr-only" htmlFor="report-source">Source</label>
      <select id="report-source" value={source} onChange={(e) => go({ source: e.target.value })} className="min-h-9 rounded-full border border-line-strong bg-surface px-3 text-sm sm:ml-auto">
        <option value="">All sources</option>
        {sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </div>
  );
}
