/**
 * Clinic-local time helpers.
 *
 * Appointments are stored in UTC and worked with in the clinic's timezone
 * (BRD 9). Every conversion here goes through the IANA database via `Intl`, so
 * daylight-saving transitions are handled by the platform rather than by an
 * offset we guess and get wrong twice a year (PRD CAL-01).
 */

/** The zone's offset from UTC, in milliseconds, at a given instant. */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  // `hour` can come back as 24 for midnight in some engines.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - at.getTime();
}

/**
 * Turn a clinic-local wall-clock time into the UTC instant it refers to.
 *
 * Two passes: the first offset is measured at an approximate instant, then
 * re-measured at the corrected one. A single pass lands in the wrong hour for
 * times near a daylight-saving boundary, because the offset before and after
 * the jump differ.
 */
export function clinicLocalToUtc(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const [hour = "00", minute = "00"] = time.split(":");
  const naive = Date.parse(`${date}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00Z`);
  if (Number.isNaN(naive)) throw new Error(`Invalid clinic-local time: ${date} ${time}`);

  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/** The `YYYY-MM-DD` a UTC instant falls on, in the clinic's timezone. */
export function clinicLocalDate(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** `HH:MM` in the clinic's timezone. */
export function clinicLocalTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

/** 0 = Sunday, matching JavaScript's getDay(), in the clinic's timezone. */
export function clinicLocalDayOfWeek(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** UTC bounds covering whole clinic-local days, `from` 00:00 to `to` 24:00. */
export function clinicDateRangeToUtc(
  from: string,
  to: string,
  timeZone: string,
): { start: Date; end: Date } {
  const start = clinicLocalToUtc(from, "00:00", timeZone);
  // Exclusive upper bound: the instant the day after `to` begins.
  const dayAfter = new Date(`${to}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  const end = clinicLocalToUtc(clinicLocalDateFromUtcDateString(dayAfter), "00:00", timeZone);
  return { start, end };
}

function clinicLocalDateFromUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
