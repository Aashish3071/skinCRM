"use client";

import { useEffect, useState } from "react";

/**
 * "Reply in 12 min" / "Reply overdue by 40 min" for a lead nobody has
 * responded to yet (D-73). Words, not just a colour, and it ticks down live.
 */
export function SlaBadge({ lead, long = false }: {
  lead: { slaDueAt: string | null; firstResponseAt: string | null; isClosed: boolean };
  long?: boolean;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!lead.slaDueAt || lead.firstResponseAt || lead.isClosed || now === null) return null;

  const diff = Math.round((new Date(lead.slaDueAt).getTime() - now) / 60_000);
  const span = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);
  const overdue = diff < 0;
  const soon = !overdue && diff <= 15;
  const text = overdue
    ? long ? `Response overdue by ${span(-diff)} — nobody has contacted them yet` : `Overdue ${span(-diff)}`
    : long ? `Respond within ${span(diff)}` : `Reply in ${span(diff)}`;

  return (
    <span
      role="status"
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
        overdue ? "bg-critical-soft text-critical" : soon ? "bg-caution-soft text-caution" : "bg-surface-muted text-ink-muted"
      } ${long ? "px-2.5 py-1 text-sm" : ""}`}
    >
      {text}
    </span>
  );
}
