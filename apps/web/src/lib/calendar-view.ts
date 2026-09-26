import { isoDate, type AppointmentStatus } from "@skincrm/contracts";

export interface CalendarOptions {
  staff: { id: string; fullName: string }[];
  branches: { id: string; name: string }[];
}

export const appointmentLabels: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled", confirmed: "Confirmed", attended: "Attended",
  no_show: "No-show", canceled: "Canceled", rescheduled: "Rescheduled",
};

export function localDate(instant: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

export function clockTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function calendarDays(date: string, view: "day" | "week"): string[] {
  if (view === "day") return [date];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const monday = shiftDate(date, -((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => shiftDate(monday, index));
}

export function validDate(value: string | undefined, fallback: string): string {
  return isoDate.safeParse(value).success ? value! : fallback;
}

export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}
