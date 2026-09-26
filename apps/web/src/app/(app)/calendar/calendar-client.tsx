"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AppointmentDto, ConsultationTypeDto, PersonDto, SetAppointmentStatus } from "@skincrm/contracts";
import { SETTABLE_APPOINTMENT_STATUSES } from "@skincrm/contracts";
import { PlusIcon } from "@/components/icons";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import { appointmentLabels, clockTime, dayLabel, hourLabel, layoutOverlaps, localDate, minutesOfDay, type CalendarOptions } from "@/lib/calendar-view";
import { bookAppointment, cancelAppointment, loadAvailability, moveAppointment, searchBookingPeople, setAppointmentStatus, type Availability } from "@/lib/calendar-actions";

const primary = buttonClasses("primary");
const secondary = buttonClasses("secondary", "sm");
type BookingPerson = { id: string; displayName: string; leadId?: string };

export function CalendarBoard({ appointments, days, date, timezone, options, types, staffId, branchId, writable, initialPerson }: {
  appointments: AppointmentDto[]; days: string[]; date: string; timezone: string; options: CalendarOptions;
  types: ConsultationTypeDto[]; staffId: string; branchId: string; writable: boolean; initialPerson?: BookingPerson;
}) {
  const router = useRouter();
  const [booking, setBooking] = useState<{ day: string; time?: string; staff?: string } | null>(initialPerson ? { day: date } : null);
  const [selected, setSelected] = useState<AppointmentDto | null>(null);
  const [moving, setMoving] = useState<AppointmentDto | null>(null);
  const [notice, setNotice] = useState("");
  const today = localDate(new Date(), timezone);
  // Phones show one day at a time; start on today if it is in view.
  const [agendaDay, setAgendaDay] = useState(days.includes(today) ? today : days[0]!);
  function done(message: string, visit?: AppointmentDto) {
    setBooking(null); setSelected(null); setMoving(null); setNotice(message);
    if (visit) router.replace(`/calendar?${new URLSearchParams({ date: localDate(visit.startsAt, timezone), view: days.length === 1 ? "day" : "week" })}`);
    router.refresh();
  }
  const open = (visit: AppointmentDto) => { setNotice(""); setSelected(visit); };
  const book = (day: string, time?: string, staff?: string) => { if (!writable) return; setNotice(""); setBooking({ day, time, staff }); };

  return <>
    <div className="mb-3 flex items-center justify-between gap-3">
      <p className="text-sm text-ink-muted">{appointments.filter((a) => a.status !== "canceled" && a.status !== "rescheduled").length} appointments</p>
      {writable && <button className={buttonClasses("primary")} onClick={() => book(days.includes(today) ? today : date)}><PlusIcon size={16} /> Book</button>}
    </div>
    {notice && <p role="status" className="mb-3 rounded-lg bg-positive-soft p-3 text-sm text-positive">{notice}</p>}

    {/* Phones and small tablets: a day strip and a simple list. */}
    <div className="md:hidden">
      {days.length > 1 && <div role="tablist" aria-label="Day" className="mb-3 grid grid-cols-7 gap-1">
        {days.map((day) => {
          const count = appointments.filter((a) => localDate(a.startsAt, timezone) === day && a.status !== "canceled" && a.status !== "rescheduled").length;
          const d = new Date(`${day}T12:00:00Z`);
          return <button key={day} role="tab" aria-selected={agendaDay === day} onClick={() => setAgendaDay(day)}
            className={`flex min-h-14 flex-col items-center justify-center rounded-lg text-xs ${agendaDay === day ? "bg-brand text-on-brand" : day === today ? "bg-brand-soft text-brand" : "bg-surface text-ink-muted"}`}>
            <span>{d.toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" })}</span>
            <span className="text-base font-semibold leading-tight">{d.getUTCDate()}</span>
            <span aria-label={`${count} appointments`} className={`mt-0.5 h-1.5 w-1.5 rounded-full ${count ? (agendaDay === day ? "bg-surface" : "bg-brand") : "bg-transparent"}`} />
          </button>;
        })}
      </div>}
      <Agenda day={days.length > 1 ? agendaDay : days[0]!} appointments={appointments} timezone={timezone} onOpen={open} onBook={writable ? book : undefined} />
    </div>

    {/* Tablets and up: a real time grid. Day view splits by staff member. */}
    <div className="hidden md:block">
      <TimeGrid days={days} appointments={appointments} timezone={timezone} staff={options.staff} staffId={staffId}
        onOpen={open} onBook={writable ? book : undefined} />
    </div>

    {(booking || moving) && <BookingDialog key={moving?.id ?? `${booking?.day}-${booking?.time}`} date={booking?.day ?? date} initialTime={booking?.time} timezone={timezone} options={options} types={types} staffId={booking?.staff || staffId} branchId={branchId}
      initialPerson={initialPerson} moving={moving} onClose={() => { setBooking(null); setMoving(null); }} onDone={done} />}
    {selected && !moving && <AppointmentDialog visit={selected} timezone={timezone} writable={writable} onClose={() => setSelected(null)} onMove={() => { setMoving(selected); setSelected(null); }} onDone={done} />}
  </>;
}

const HOUR_PX = 52;
const inactive = (a: AppointmentDto) => a.status === "canceled" || a.status === "rescheduled";

/** Colour follows status, but the status is also written on hover and in the dialog — never colour alone. */
function blockTone(a: AppointmentDto): string {
  if (inactive(a)) return "border-line-strong bg-surface-muted text-ink-subtle line-through";
  if (a.status === "attended") return "border-positive bg-positive-soft text-ink";
  if (a.status === "no_show") return "border-critical bg-critical-soft text-ink";
  if (a.status === "confirmed") return "border-brand bg-brand-soft text-ink";
  return "border-brand bg-surface text-ink";
}

function TimeGrid({ days, appointments, timezone, staff, staffId, onOpen, onBook }: {
  days: string[]; appointments: AppointmentDto[]; timezone: string; staff: CalendarOptions["staff"]; staffId: string;
  onOpen: (a: AppointmentDto) => void; onBook?: (day: string, time?: string, staff?: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  // Columns: one per day in week view; one per staff member in day view.
  const dayView = days.length === 1;
  const people = dayView ? staff.filter((s) => (staffId ? s.id === staffId : true)) : [];
  const columns = dayView
    ? (people.length ? people : [{ id: "", fullName: "Appointments" }]).map((s) => ({ key: s.id || "all", day: days[0]!, label: s.fullName, staffId: s.id }))
    : days.map((d) => ({ key: d, day: d, label: d, staffId: "" }));

  const visible = appointments;
  const mins = visible.map((a) => [minutesOfDay(a.startsAt, timezone), minutesOfDay(a.clientVisibleEndsAt ?? a.endsAt, timezone)] as const);
  const startHour = Math.min(8, ...mins.map(([s]) => Math.floor(s / 60)));
  const endHour = Math.max(19, ...mins.map(([, e]) => Math.ceil(e / 60)));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const today = localDate(now, timezone);
  const nowMin = minutesOfDay(now, timezone);

  useEffect(() => {
    // Open scrolled to the working day, not midnight.
    scroller.current?.scrollTo({ top: Math.max(0, ((today && days.includes(today) ? nowMin / 60 : 9) - startHour - 1) * HOUR_PX) });
  }, [days, today, nowMin, startHour]);

  return <div className="overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow-card)]">
    <div className="grid border-b border-line" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(0, 1fr))` }}>
      <div />
      {columns.map((c) => {
        const isToday = c.day === today;
        const d = new Date(`${c.day}T12:00:00Z`);
        return <div key={c.key} className="border-l border-line px-2 py-2 text-center">
          {dayView ? <p className="truncate text-sm font-medium">{c.label}</p> : <>
            <p className={`text-xs uppercase tracking-wide ${isToday ? "text-brand" : "text-ink-subtle"}`}>{d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</p>
            <p className={`mx-auto mt-0.5 flex h-8 w-8 items-center justify-center rounded-full text-base font-semibold ${isToday ? "bg-brand text-on-brand" : ""}`}>{d.getUTCDate()}</p>
          </>}
        </div>;
      })}
    </div>
    <div ref={scroller} className="max-h-[calc(100vh-17rem)] min-h-96 overflow-y-auto">
      <div className="relative grid" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(0, 1fr))`, height: hours.length * HOUR_PX }}>
        <div className="relative">
          {hours.map((h, i) => <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-ink-subtle" style={{ top: i * HOUR_PX }}>{i === 0 ? "" : hourLabel(h)}</span>)}
        </div>
        {columns.map((c) => {
          const items = layoutOverlaps(visible
            .filter((a) => localDate(a.startsAt, timezone) === c.day && (!c.staffId || a.staffUserId === c.staffId))
            .map((a) => ({ a, start: minutesOfDay(a.startsAt, timezone), end: Math.max(minutesOfDay(a.clientVisibleEndsAt ?? a.endsAt, timezone), minutesOfDay(a.startsAt, timezone) + 15) })));
          return <div key={c.key} className="relative border-l border-line">
            {hours.map((h, i) => <button key={h} type="button" disabled={!onBook} tabIndex={-1} aria-hidden="true"
              onClick={() => onBook?.(c.day, `${String(h).padStart(2, "0")}:00`, c.staffId || undefined)}
              className="absolute inset-x-0 border-t border-line hover:bg-brand-soft/40 disabled:hover:bg-transparent" style={{ top: i * HOUR_PX, height: HOUR_PX }} />)}
            {c.day === today && nowMin >= startHour * 60 && nowMin <= endHour * 60 && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-critical" style={{ top: ((nowMin - startHour * 60) / 60) * HOUR_PX }}>
              <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-critical" /></div>}
            {items.map(({ a, start, end, col, cols }) => {
              const top = ((start - startHour * 60) / 60) * HOUR_PX;
              const height = Math.max(22, ((end - start) / 60) * HOUR_PX - 2);
              const short = height < 40;
              return <button key={a.id} type="button" onClick={() => onOpen(a)}
                title={`${clockTime(a.startsAt, timezone)} ${a.personName} · ${a.consultationTypeName ?? "Consultation"} · ${a.staffName} · ${appointmentLabels[a.status]}`}
                className={`absolute z-[5] overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-left shadow-[var(--shadow-card)] hover:z-20 hover:ring-2 hover:ring-brand ${blockTone(a)}`}
                style={{ top, height, left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)` }}>
                <span className={`block truncate text-xs font-semibold ${short ? "inline" : ""}`}>{a.personName}</span>
                <span className={`block truncate text-[11px] text-ink-muted ${short ? "hidden" : ""}`}>{clockTime(a.startsAt, timezone)} · {dayView ? (a.consultationTypeName ?? "Consultation") : a.staffName}</span>
                <span className="sr-only">, {appointmentLabels[a.status]}</span>
              </button>;
            })}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

function Agenda({ day, appointments, timezone, onOpen, onBook }: {
  day: string; appointments: AppointmentDto[]; timezone: string; onOpen: (a: AppointmentDto) => void; onBook?: (day: string) => void;
}) {
  const items = appointments.filter((a) => localDate(a.startsAt, timezone) === day).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return <section aria-label={dayLabel(day)}>
    <h2 className="mb-2 text-sm font-semibold">{new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</h2>
    {items.length === 0 ? <div className="rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-ink-muted">
      Nothing booked.{onBook && <> <button onClick={() => onBook(day)} className="font-medium text-brand">Book someone in</button></>}
    </div> : <ol className="overflow-hidden rounded-card border border-line bg-surface">
      {items.map((a) => <li key={a.id} className="border-b border-line last:border-0">
        <button type="button" onClick={() => onOpen(a)} className={`flex w-full items-stretch gap-3 p-3 text-left ${inactive(a) ? "opacity-60" : ""}`}>
          <span className="w-16 shrink-0 text-sm">
            <span className="block font-semibold">{clockTime(a.startsAt, timezone)}</span>
            <span className="block text-xs text-ink-subtle">{clockTime(a.clientVisibleEndsAt ?? a.endsAt, timezone)}</span>
          </span>
          <span className={`w-1 shrink-0 rounded-full ${a.status === "attended" ? "bg-positive" : a.status === "no_show" ? "bg-critical" : inactive(a) ? "bg-line-strong" : "bg-brand"}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className={`block truncate font-medium ${inactive(a) ? "line-through" : ""}`}>{a.personName}</span>
            <span className="block truncate text-sm text-ink-muted">{a.consultationTypeName ?? "Consultation"} · {a.staffName}</span>
          </span>
          <Badge tone={a.status === "attended" ? "positive" : a.status === "no_show" ? "critical" : "neutral"}>{appointmentLabels[a.status]}</Badge>
        </button>
      </li>)}
    </ol>}
  </section>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={onClose} onClose={onClose} aria-labelledby="dialog-title" className="fixed inset-0 m-auto max-h-[92dvh] w-[min(42rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40">
    <header className="flex items-center justify-between border-b border-line px-5 py-4"><h2 id="dialog-title" className="font-semibold">{title}</h2><button type="button" onClick={onClose} className={secondary} aria-label="Close dialog">Close</button></header>
    <div className="p-5">{children}</div>
  </dialog>;
}

function BookingDialog({ date, initialTime, timezone, options, types, staffId, branchId, initialPerson, moving, onClose, onDone }: {
  date: string; initialTime?: string; timezone: string; options: CalendarOptions; types: ConsultationTypeDto[]; staffId: string; branchId: string;
  initialPerson?: BookingPerson; moving: AppointmentDto | null; onClose: () => void; onDone: (message: string, visit?: AppointmentDto) => void;
}) {
  const [person, setPerson] = useState<BookingPerson | null>(moving ? { id: moving.personId, displayName: moving.personName, leadId: moving.leadId ?? undefined } : initialPerson ?? null);
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<PersonDto[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, startSearch] = useTransition();
  const [day, setDay] = useState(moving ? localDate(moving.startsAt, timezone) : date);
  const [typeId, setTypeId] = useState(moving?.consultationTypeId ?? "");
  const [staff, setStaff] = useState(moving?.staffUserId ?? staffId ?? "");
  const [branch, setBranch] = useState(moving?.branchId ?? branchId);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(false);
  const [slot, setSlot] = useState("");
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [slotError, setSlotError] = useState("");
  const [pending, startSave] = useTransition();
  const chosenType = types.find((t) => t.id === typeId);
  const eligible = options.staff.filter((s) => !chosenType?.eligibleStaffIds.length || chosenType.eligibleStaffIds.includes(s.id));

  useEffect(() => {
    let active = true;
    setSlot(""); setAvailability(null); setSlotError("");
    if (!staff || !day) { setLoading(false); return; }
    setLoading(true);
    loadAvailability({ date: day, staffUserId: staff, consultationTypeId: typeId || undefined, rescheduleAppointmentId: moving?.id }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.ok) {
        setAvailability(result.data);
        // Clicked an empty hour on the grid: preselect the first free slot in it.
        if (initialTime) {
          const match = result.data.slots.find((s) => s.available && clockTime(s.startsAt, timezone) !== "" && minutesOfDay(s.startsAt, timezone) >= Number(initialTime.slice(0, 2)) * 60 && minutesOfDay(s.startsAt, timezone) < Number(initialTime.slice(0, 2)) * 60 + 60);
          if (match) setSlot(match.startsAt);
        }
      } else setSlotError(result.message);
    });
    return () => { active = false; };
  }, [day, staff, typeId, moving?.id, reload, initialTime, timezone]);

  return <Modal title={moving ? "Reschedule appointment" : "Book appointment"} onClose={onClose}>
    <p className="mb-4 text-sm text-ink-muted">Times shown in {timezone.replace(/_/g, " ")}. {moving ? "The original slot stays booked until the move succeeds." : "Choose a person, staff member, and available time."}</p>
    {!person && <form className="mb-4" onSubmit={(event) => { event.preventDefault(); startSearch(async () => {
      setError(""); const result = await searchBookingPeople(search); setSearched(true);
      if (result.ok) setPeople(result.data.items); else setError(result.message);
    }); }}>
      <Field label="Find a person" htmlFor="booking-search"><div className="flex gap-2"><input id="booking-search" value={search} onChange={(e) => { setSearch(e.target.value); setSearched(false); setPeople([]); }} required minLength={2} placeholder="Name, phone, or email" className={inputClasses} /><button disabled={searching} className={secondary}>{searching ? "Searching…" : "Search"}</button></div></Field>
      {searched && !people.length && <p className="mt-2 text-sm text-ink-muted">No matches. <Link href="/leads/new" className="text-brand">Create an inquiry first.</Link></p>}
      <ul className="mt-2 flex flex-col gap-1">{people.map((p) => <li key={p.id}><button type="button" className="w-full rounded border border-line p-2 text-left text-sm hover:bg-brand-soft" onClick={() => setPerson({ id: p.id, displayName: p.displayName })}>{p.displayName}<span className="ml-2 text-xs text-ink-subtle">{p.phone ?? p.email}</span></button></li>)}</ul>
    </form>}
    {person && <div className="mb-4 flex items-center justify-between rounded bg-brand-soft p-3 text-sm"><div><p className="font-medium">{person.displayName}</p>{person.leadId && <p className="text-xs text-ink-muted">Linked to the selected inquiry</p>}</div>{!moving && <button className="text-brand" onClick={() => { setPerson(null); setPeople([]); setSearched(false); }}>Change person</button>}</div>}
    <form onSubmit={(event) => {
      event.preventDefault(); if (!person || !slot) return;
      const form = new FormData(event.currentTarget);
      startSave(async () => {
        setError("");
        const result = moving ? await moveAppointment(moving.id, { startsAt: slot, staffUserId: staff, reason: String(form.get("reason")), allowOutsideWorkingHours: false })
          : await bookAppointment({ personId: person.id, leadId: person.leadId, staffUserId: staff, consultationTypeId: typeId || null, branchId: branch || null, startsAt: slot, note: String(form.get("note") ?? ""), allowOutsideWorkingHours: false });
        if (result.ok) onDone(`${moving ? "Appointment moved" : "Appointment booked"} for ${dayLabel(localDate(result.data.startsAt, timezone))} at ${clockTime(result.data.startsAt, timezone)}.`, result.data);
        else { setError(result.message); if (result.conflict) setReload((n) => n + 1); }
      });
    }} className="flex flex-col gap-4">
      <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
        <Field label="Consultation type" htmlFor="booking-type"><select id="booking-type" disabled={Boolean(moving)} value={typeId} className={inputClasses} onChange={(e) => { setTypeId(e.target.value); setStaff(""); }}><option value="">General consultation · 30 min</option>{types.filter((t) => t.isActive || t.id === moving?.consultationTypeId).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.durationMinutes} min{t.bufferMinutes ? ` + ${t.bufferMinutes} min buffer` : ""}</option>)}</select></Field>
        <Field label="Staff member" htmlFor="booking-staff"><select id="booking-staff" value={staff} onChange={(e) => setStaff(e.target.value)} required className={inputClasses}><option value="">Choose staff</option>{eligible.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></Field>
        <Field label="Date" htmlFor="booking-date"><input id="booking-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} required className={inputClasses} /></Field>
        <Field label="Branch" htmlFor="booking-branch"><select id="booking-branch" disabled={Boolean(moving)} value={branch} onChange={(e) => setBranch(e.target.value)} className={inputClasses}><option value="">No branch selected</option>{options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      </fieldset>
      <fieldset disabled={pending || loading}>
        <legend className="mb-2 text-sm font-medium">Available start times</legend>
        {loading ? <p role="status" className="text-sm text-ink-muted">Checking availability…</p> : !staff ? <p className="text-sm text-ink-muted">Choose a staff member to see their availability.</p> : null}
        {slotError && <p role="alert" className="text-sm text-critical">{slotError}</p>}
        {availability && !availability.slots.length && <p className="text-sm text-ink-muted">No working hours for this day. Choose another date, or ask an admin to configure working hours in Calendar settings.</p>}
        {availability && availability.slots.length > 0 && !availability.slots.some((s) => s.available) && <p className="mb-2 text-sm text-caution">No free times remain. Try another date or staff member.</p>}
        <div className="grid max-h-52 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">{availability?.slots.map((s) => <label key={s.startsAt} className={`cursor-pointer rounded border px-2 py-2 text-center text-xs ${!s.available ? "cursor-not-allowed border-line bg-surface-muted text-ink-subtle" : slot === s.startsAt ? "border-brand bg-brand-soft text-brand" : "border-line hover:border-brand"}`}>
          <input type="radio" name="slot" value={s.startsAt} disabled={!s.available} checked={slot === s.startsAt} onChange={() => setSlot(s.startsAt)} className="mr-1" />{clockTime(s.startsAt, timezone)}{!s.available && <span className="block text-[10px]">{s.reason === "in_past" ? "Past" : s.reason === "booked" ? "Booked" : "Outside hours"}</span>}
        </label>)}</div>
      </fieldset>
      {moving ? <Field label="Reason for rescheduling" htmlFor="booking-reason"><textarea id="booking-reason" name="reason" required maxLength={500} className={inputClasses} /></Field>
        : <Field label="Scheduling note (optional)" htmlFor="booking-note"><textarea id="booking-note" name="note" maxLength={2000} className={inputClasses} /></Field>}
      {error && <p role="alert" className="rounded bg-critical-soft p-3 text-sm text-critical">{error}</p>}
      <button disabled={pending || loading || !person || !slot} className={primary}>{pending ? "Saving…" : moving ? "Confirm reschedule" : "Confirm booking"}</button>
    </form>
  </Modal>;
}

function AppointmentDialog({ visit, timezone, writable, onClose, onMove, onDone }: {
  visit: AppointmentDto; timezone: string; writable: boolean; onClose: () => void; onMove: () => void; onDone: (message: string, visit?: AppointmentDto) => void;
}) {
  const [error, setError] = useState("");
  const [pending, startSave] = useTransition();
  const [canceling, setCanceling] = useState(false);
  const active = visit.status !== "canceled" && visit.status !== "rescheduled";
  return <Modal title={visit.personName} onClose={onClose}>
    <div className="mb-5 flex flex-col gap-2 text-sm">
      <p className="font-medium">{dayLabel(localDate(visit.startsAt, timezone))} · {clockTime(visit.startsAt, timezone)}–{clockTime(visit.clientVisibleEndsAt ?? visit.endsAt, timezone)}</p>
      <p className="text-ink-muted">{timezone} · {visit.staffName}</p>
      <p>{visit.consultationTypeName ?? "General consultation"}</p>
      <div><Badge>{appointmentLabels[visit.status]}</Badge></div>
      {visit.note && <p className="whitespace-pre-wrap rounded bg-surface-muted p-3">{visit.note}</p>}
      {visit.changeReason && <p className="text-ink-muted">Reason: {visit.changeReason}</p>}
      <div className="mt-2 flex gap-4"><Link href={`/people/${visit.personId}`} className="text-brand">Person profile</Link>{visit.leadId && <Link href={`/leads/${visit.leadId}`} className="text-brand">Linked inquiry</Link>}</div>
    </div>
    {writable && active && <div className="flex flex-col gap-4">
      <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); startSave(async () => {
        const result = await setAppointmentStatus(visit.id, String(form.get("status")) as SetAppointmentStatus["status"]);
        if (result.ok) onDone(`Appointment marked ${appointmentLabels[result.data.status].toLowerCase()}.`); else setError(result.message);
      }); }}>
        <Field label="Appointment status" htmlFor="visit-status"><select id="visit-status" name="status" defaultValue={visit.status} className={inputClasses}>{SETTABLE_APPOINTMENT_STATUSES.map((status) => <option key={status} value={status}>{appointmentLabels[status]}</option>)}</select></Field>
        <button disabled={pending} className={secondary}>Update status</button>
      </form>
      <div className="flex gap-3"><button disabled={pending} onClick={onMove} className={secondary}>Reschedule</button><button disabled={pending} onClick={() => setCanceling(!canceling)} className="text-sm text-critical">Cancel appointment</button></div>
      {canceling && <form className="flex flex-col gap-3 rounded border border-line p-3" onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); startSave(async () => {
        const result = await cancelAppointment(visit.id, String(form.get("reason")));
        if (result.ok) onDone("Appointment canceled. The time is available again."); else setError(result.message);
      }); }}>
        <Field label="Reason for cancellation" htmlFor="cancel-reason"><textarea id="cancel-reason" name="reason" required maxLength={500} className={inputClasses} /></Field>
        <button disabled={pending} className="rounded bg-critical px-4 py-2 text-sm text-on-brand">Confirm cancellation</button>
      </form>}
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-critical">{error}</p>}
  </Modal>;
}
