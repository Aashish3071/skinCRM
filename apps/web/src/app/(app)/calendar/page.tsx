import Link from "next/link";
import { uuidSchema } from "@skincrm/contracts";
import { PageHeader, inputClasses } from "@/components/ui";
import { can, requireCapability } from "@/lib/session";
import { getAppointments, getCalendarOptions, getConsultationTypes } from "@/lib/calendar";
import { calendarDays, dayLabel, localDate, shiftDate, validDate } from "@/lib/calendar-view";
import { getLead } from "@/lib/crm";
import { CalendarBoard } from "./calendar-client";

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
  const url = (nextDate: string, nextView = view) => `/calendar?${new URLSearchParams({ date: nextDate, view: nextView, staffUserId: staffId, branchId, includeCanceled: String(includeCanceled) })}`;

  return <>
    <PageHeader title="Calendar" description={`All times in ${timezone.replace(/_/g, " ")}.`}
      actions={can(session, "settings:write") ? <Link href="/settings/calendar" className="text-sm text-brand">Calendar settings</Link> : null} />
    <div className="mb-4 rounded-card border border-line bg-surface p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={url(shiftDate(date, view === "day" ? -1 : -7))} className="rounded border border-line px-3 py-2 text-sm" aria-label={`Previous ${view}`}>←</Link>
          <h2 className="text-sm font-semibold">{dayLabel(days[0]!)}{view === "week" ? ` – ${dayLabel(days[6]!)}` : ""}</h2>
          <Link href={url(shiftDate(date, view === "day" ? 1 : 7))} className="rounded border border-line px-3 py-2 text-sm" aria-label={`Next ${view}`}>→</Link>
          <Link href={url(today)} className="text-sm text-brand">Today</Link>
        </div>
        <nav aria-label="Calendar view" className="flex gap-1 rounded-md bg-surface-muted p-1">
          {(["day", "week"] as const).map((mode) => <Link key={mode} href={url(date, mode)} aria-current={view === mode ? "page" : undefined} className={`rounded px-4 py-1.5 text-sm capitalize ${view === mode ? "bg-surface font-semibold text-brand" : "text-ink-muted"}`}>{mode}</Link>)}
        </nav>
      </div>
      <form className="flex flex-wrap items-end gap-3" action="/calendar">
        <input type="hidden" name="view" value={view} />
        <label className="text-xs font-medium">Date<input type="date" aria-label="Calendar date" name="date" defaultValue={date} required className={`${inputClasses} mt-1`} /></label>
        <label className="text-xs font-medium">Staff<select aria-label="Filter by staff" name="staffUserId" defaultValue={staffId} className={`${inputClasses} mt-1`}><option value="">All available staff</option>{options.staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label className="text-xs font-medium">Branch<select aria-label="Filter by branch" name="branchId" defaultValue={branchId} className={`${inputClasses} mt-1`}><option value="">All branches</option>{options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="flex items-center gap-2 py-2 text-sm"><input type="checkbox" name="includeCanceled" value="true" defaultChecked={includeCanceled} />Show canceled and rescheduled</label>
        <button className="rounded-md border border-line-strong px-4 py-2 text-sm">Apply filters</button>
      </form>
    </div>
    <CalendarBoard appointments={data.items} days={days} date={date} timezone={timezone} options={options} types={types}
      staffId={staffId} branchId={branchId} writable={can(session, "appointments:write")}
      initialPerson={lead ? { id: lead.personId, displayName: lead.personName, leadId: lead.id } : undefined} />
  </>;
}
