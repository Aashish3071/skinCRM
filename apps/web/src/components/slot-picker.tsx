"use client";

import { useEffect, useState, useTransition } from "react";
import type { PublicSlots } from "@skincrm/contracts";
import type { Outcome } from "@/lib/booking-actions";

/** A clinic-local calendar date, `YYYY-MM-DD`, some days from today. */
function localDay(offset: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86_400_000));
}

export function formatTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
}

export function formatDay(iso: string, timeZone: string, style: "long" | "short" = "long") {
  return new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: style, month: style === "long" ? "long" : "short", day: "numeric" });
}

/**
 * Pick a day (the next two weeks, as buttons) and then a free time. Times are
 * always shown in the clinic's time zone and labelled as such, so a patient
 * booking from another state isn't caught out.
 */
export function SlotPicker({
  timezone,
  load,
  value,
  onChange,
  days = 14,
}: {
  timezone: string;
  load: (date: string) => Promise<Outcome<PublicSlots>>;
  value: string | null;
  onChange: (startsAt: string | null) => void;
  days?: number;
}) {
  const dates = Array.from({ length: days }, (_, i) => localDay(i, timezone));
  const [date, setDate] = useState(dates[0]!);
  const [times, setTimes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    start(async () => {
      setError(null);
      const r = await load(date);
      if (r.ok) setTimes(r.data.startTimes);
      else { setTimes([]); setError(r.message); }
    });
    // Re-run on the day only: `load` is recreated by the parent each render.
  }, [date]);

  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="text-sm font-medium">Day</legend>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {dates.map((d) => {
            const noon = `${d}T12:00:00Z`;
            const label = new Date(noon).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
            const num = new Date(noon).getUTCDate();
            const month = new Date(noon).toLocaleDateString("en-US", { timeZone: "UTC", month: "short" });
            return (
              <button key={d} type="button" aria-pressed={d === date} onClick={() => { setDate(d); onChange(null); }}
                aria-label={new Date(noon).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" })}
                className={`flex min-h-16 min-w-14 shrink-0 flex-col items-center justify-center rounded-lg border text-xs ${d === date ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-surface hover:bg-surface-muted"}`}>
                <span>{label}</span>
                <span className="text-base font-semibold leading-tight">{num}</span>
                <span>{month}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset aria-busy={pending}>
        <legend className="text-sm font-medium">Time <span className="font-normal text-ink-subtle">({timezone.replace(/_/g, " ")})</span></legend>
        {pending || times === null ? (
          <p role="status" className="mt-2 text-sm text-ink-muted">Finding free times…</p>
        ) : error ? (
          <p role="alert" className="mt-2 text-sm text-critical">{error}</p>
        ) : times.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No free times that day. Try another day.</p>
        ) : (
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {times.map((t) => (
              <label key={t} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg border text-sm ${value === t ? "border-brand bg-brand-soft font-medium text-brand" : "border-line-strong hover:border-brand"}`}>
                <input type="radio" name="slot" value={t} checked={value === t} onChange={() => onChange(t)} className="sr-only" />
                {formatTime(t, timezone)}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}
