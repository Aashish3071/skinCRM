import type { StageCategory } from "@skincrm/contracts";

/** Tone for a stage badge, keyed by the stable category rather than the name. */
export function stageTone(category: StageCategory): "neutral" | "brand" | "positive" | "caution" | "critical" {
  switch (category) {
    case "converted":
      return "positive";
    case "consultation_booked":
    case "consultation_attended":
      return "brand";
    case "lost":
      return "critical";
    default:
      return "neutral";
  }
}

/** "3 days ago" style, for timelines where the exact second rarely matters. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Absolute time in the clinic's timezone, for anything a clinic acts on. */
export function clinicTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "Today", "Yesterday", or a date — in the clinic's timezone. */
export function dayLabel(iso: string, timeZone: string): string {
  const key = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const day = key(new Date(iso));
  const today = key(new Date());
  const yesterday = key(new Date(Date.now() - 86_400_000));
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
}

/** Group items under day headings, preserving order. */
export function groupByDay<T>(items: T[], at: (item: T) => string, timeZone: string): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = dayLabel(at(item), timeZone);
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** Group a newest-first feed by a stable record id, keeping first-seen group order. */
export function groupByKey<T>(items: T[], keyOf: (item: T) => string): { key: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups].map(([key, grouped]) => ({ key, items: grouped }));
}

/** Time of day in the clinic's timezone, e.g. "2:30 PM". */
export function clinicClock(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
