"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AppointmentDto, ConsultationTypeDto, PersonDto, SetAppointmentStatus } from "@skincrm/contracts";
import { SETTABLE_APPOINTMENT_STATUSES } from "@skincrm/contracts";
import { Badge, Field, inputClasses } from "@/components/ui";
import { appointmentLabels, clockTime, dayLabel, localDate, type CalendarOptions } from "@/lib/calendar-view";
import { bookAppointment, cancelAppointment, loadAvailability, moveAppointment, searchBookingPeople, setAppointmentStatus, type Availability } from "@/lib/calendar-actions";

const primary = "rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50";
const secondary = "rounded-md border border-line-strong px-3 py-2 text-sm hover:bg-surface-muted disabled:opacity-50";
type BookingPerson = { id: string; displayName: string; leadId?: string };

export function CalendarBoard({ appointments, days, date, timezone, options, types, staffId, branchId, writable, initialPerson }: {
  appointments: AppointmentDto[]; days: string[]; date: string; timezone: string; options: CalendarOptions;
  types: ConsultationTypeDto[]; staffId: string; branchId: string; writable: boolean; initialPerson?: BookingPerson;
}) {
  const router = useRouter();
  const [booking, setBooking] = useState(Boolean(initialPerson));
  const [selected, setSelected] = useState<AppointmentDto | null>(null);
  const [moving, setMoving] = useState<AppointmentDto | null>(null);
  const [notice, setNotice] = useState("");
  function done(message: string, visit?: AppointmentDto) {
    setBooking(false); setSelected(null); setMoving(null); setNotice(message);
    if (visit) router.replace(`/calendar?${new URLSearchParams({ date: localDate(visit.startsAt, timezone), view: days.length === 1 ? "day" : "week" })}`);
    router.refresh();
  }
  const columns = days.length === 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-7";

  return <>
    <div className="mb-4 flex items-center justify-between gap-3">
      <p className="text-sm text-ink-muted">{appointments.length} appointment{appointments.length === 1 ? "" : "s"} in this view</p>
      {writable && <button className={primary} onClick={() => { setNotice(""); setBooking(true); }}>Book appointment</button>}
    </div>
    {notice && <p role="status" className="mb-4 rounded-md bg-positive-soft p-3 text-sm text-positive">{notice}</p>}
    <div className={`grid gap-3 ${columns}`}>
      {days.map((day) => {
        const visits = appointments.filter((a) => localDate(a.startsAt, timezone) === day);
        const today = localDate(new Date(), timezone) === day;
        return <section key={day} aria-label={dayLabel(day)} className="min-w-0 rounded-card border border-line bg-surface">
          <h3 className={`border-b border-line p-3 text-sm font-semibold ${today ? "bg-brand-soft text-brand" : ""}`}>{dayLabel(day)}{today ? " · Today" : ""}</h3>
          <div className={`p-2 ${days.length === 1 ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" : "min-h-40"}`}>
            {visits.length === 0 && <p className="p-3 text-xs text-ink-subtle">No appointments</p>}
            {visits.map((visit) => <button key={visit.id} onClick={() => { setNotice(""); setSelected(visit); }} className={`mb-2 block w-full rounded-md border border-line p-3 text-left hover:border-brand ${visit.status === "canceled" || visit.status === "rescheduled" ? "bg-surface-muted opacity-70" : "bg-surface"}`}>
              <p className="text-xs font-semibold text-brand">{clockTime(visit.startsAt, timezone)} – {clockTime(visit.clientVisibleEndsAt ?? visit.endsAt, timezone)}</p>
              <p className="mt-2 break-words text-sm font-medium">{visit.personName}</p>
              <p className="mt-1 break-words text-xs text-ink-muted">{visit.consultationTypeName ?? "Consultation"}</p>
              <p className="mt-2 text-xs text-ink-muted">{visit.staffName}</p>
              {visit.branchId && <p className="mt-1 text-xs text-ink-subtle">{options.branches.find((b) => b.id === visit.branchId)?.name ?? "Branch"}</p>}
              <div className="mt-2"><Badge tone={visit.status === "attended" ? "positive" : visit.status === "no_show" ? "critical" : "neutral"}>{appointmentLabels[visit.status]}</Badge></div>
            </button>)}
          </div>
        </section>;
      })}
    </div>
    {(booking || moving) && <BookingDialog key={moving?.id ?? "new"} date={date} timezone={timezone} options={options} types={types} staffId={staffId} branchId={branchId}
      initialPerson={initialPerson} moving={moving} onClose={() => { setBooking(false); setMoving(null); }} onDone={done} />}
    {selected && !moving && <AppointmentDialog visit={selected} timezone={timezone} writable={writable} onClose={() => setSelected(null)} onMove={() => { setMoving(selected); setSelected(null); }} onDone={done} />}
  </>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={onClose} onClose={onClose} aria-labelledby="dialog-title" className="fixed inset-0 m-auto max-h-[90vh] w-[min(42rem,94vw)] overflow-y-auto rounded-xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40">
    <header className="flex items-center justify-between border-b border-line px-5 py-4"><h2 id="dialog-title" className="font-semibold">{title}</h2><button type="button" onClick={onClose} className={secondary} aria-label="Close dialog">Close</button></header>
    <div className="p-5">{children}</div>
  </dialog>;
}

function BookingDialog({ date, timezone, options, types, staffId, branchId, initialPerson, moving, onClose, onDone }: {
  date: string; timezone: string; options: CalendarOptions; types: ConsultationTypeDto[]; staffId: string; branchId: string;
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
      if (result.ok) setAvailability(result.data); else setSlotError(result.message);
    });
    return () => { active = false; };
  }, [day, staff, typeId, moving?.id, reload]);

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
        <button disabled={pending} className="rounded bg-critical px-4 py-2 text-sm text-white">Confirm cancellation</button>
      </form>}
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-critical">{error}</p>}
  </Modal>;
}
