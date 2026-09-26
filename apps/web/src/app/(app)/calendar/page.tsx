import Link from "next/link";
import { uuidSchema } from "@skincrm/contracts";
import { PageHeader } from "@/components/ui";
import { can, requireCapability } from "@/lib/session";
import { getAppointments, getCalendarOptions, getConsultationTypes } from "@/lib/calendar";
import { calendarDays, localDate, shiftDate, validDate } from "@/lib/calendar-view";
import { getLead } from "@/lib/crm";
import { CalendarBoard } from "./calendar-client";
import { CalendarToolbar } from "./toolbar";

export const metadata = { title: "Calendar — SkinCRM" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireCapability("appointments:read");
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] as string : "";
  const timezone = session.clinic.timezone;
  const today = localDate(new Date(), timezone);
  const date = validDate(value("date"), today);
  const view = value("view") === "day" ? "day" : "week";
  const days = calendarDays(date, view);
  const [options, types] = await Promise.all([getCalendarOptions(), getConsultationTypes()]);
  const staffId = options.staff.some((s) => s.id === value("staffUserId")) ? value("staffUserId") : "";
  const branchId = options.branches.some((b) => b.id === value("branchId")) ? value("branchId") : "";
  const includeCanceled = value("includeCanceled") === "true";
  const query = new URLSearchParams({ from: days[0]!, to: days[days.length - 1]!, includeCanceled: String(includeCanceled) });
  if (staffId) query.set("staffUserId", staffId);
  if (branchId) query.set("branchId", branchId);
  const data = await getAppointments(query.toString());
  const lead = uuidSchema.safeParse(value("leadId")).success && can(session, "leads:read") ? await getLead(value("leadId")) : null;
  const url = (nextDate: string, nextView = view) => {
    const q = new URLSearchParams({ date: nextDate, view: nextView, staffUserId: staffId, branchId, includeCanceled: includeCanceled ? "true" : "" });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return `/calendar?${q}`;
  };

  const title = view === "day"
    ? new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })
    : rangeTitle(days[0]!, days[6]!);

  return <>
    <PageHeader title="Calendar" description={`Times in ${timezone.replace(/_/g, " ")}.`}
      actions={can(session, "settings:write") ? <Link href="/settings/calendar" className="text-sm text-ink-muted hover:text-ink">Hours & appointment types</Link> : null} />
    <CalendarToolbar title={title} view={view} options={options} staffId={staffId} branchId={branchId} includeCanceled={includeCanceled}
      prevHref={url(shiftDate(date, view === "day" ? -1 : -7))} nextHref={url(shiftDate(date, view === "day" ? 1 : 7))} todayHref={url(today)} />
    <CalendarBoard appointments={data.items} days={days} date={date} timezone={timezone} options={options} types={types}
      staffId={staffId} branchId={branchId} writable={can(session, "appointments:write")}
      initialPerson={lead ? { id: lead.personId, displayName: lead.personName, leadId: lead.id } : undefined} />
  </>;
}

function rangeTitle(from: string, to: string): string {
  const a = new Date(`${from}T12:00:00Z`);
  const b = new Date(`${to}T12:00:00Z`);
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${month(a)} ${a.getUTCDate()} – ${b.getUTCDate()}, ${b.getUTCFullYear()}`
    : `${month(a)} ${a.getUTCDate()} – ${month(b)} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}
