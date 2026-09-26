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
