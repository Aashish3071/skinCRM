"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DAY_NAMES, type ConsultationTypeDto, type WorkingHoursDto } from "@skincrm/contracts";
import { Badge, Card, Field, inputClasses } from "@/components/ui";
import type { CalendarOptions } from "@/lib/calendar-view";
import { saveConsultationType, saveWorkingHours } from "@/lib/calendar-actions";

const button = "rounded-md bg-brand px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-50";
const smallButton = "rounded border border-line-strong px-3 py-1.5 text-sm disabled:opacity-50";

export function CalendarSettings({ options, types, hours }: { options: CalendarOptions; types: ConsultationTypeDto[]; hours: WorkingHoursDto[] }) {
  const [editing, setEditing] = useState<ConsultationTypeDto | null | undefined>(undefined);
  const [scope, setScope] = useState("");
  return <div className="grid items-start gap-5 lg:grid-cols-2">
    <Card title="Consultation types" description="Set visit duration, reserved buffer time, and eligible staff."
      actions={<button className={smallButton} onClick={() => setEditing(null)}>Add type</button>}>
      {!types.length && <p className="mb-4 text-sm text-ink-muted">No types configured. General consultations use 30 minutes.</p>}
      <ul className="mb-4 flex flex-col gap-3">{types.map((type) => <li key={type.id} className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <div><p className="text-sm font-medium">{type.name} {!type.isActive && <Badge>Inactive</Badge>}</p><p className="mt-1 text-xs text-ink-muted">{type.durationMinutes} min · {type.bufferMinutes} min buffer · {type.eligibleStaffIds.length ? `${type.eligibleStaffIds.length} eligible staff` : "All staff"}</p></div>
        <button className={smallButton} onClick={() => setEditing(type)} aria-label={`Edit ${type.name}`}>Edit</button>
      </li>)}</ul>
      {editing !== undefined && <TypeForm key={editing?.id ?? "new"} value={editing} options={options} onClose={() => setEditing(undefined)} />}
    </Card>
    <Card title="Working hours" description="Clinic defaults apply to staff who have no personal schedule. Saving replaces the selected schedule.">
      <Field label="Schedule for" htmlFor="hours-scope"><select id="hours-scope" className={inputClasses} value={scope} onChange={(e) => setScope(e.target.value)}><option value="">Clinic default</option>{options.staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></Field>
      <HoursForm key={`${scope}:${JSON.stringify(hours)}`} userId={scope || null} hours={hours.filter((h) => h.userId === (scope || null))} />
    </Card>
  </div>;
}

function TypeForm({ value, options, onClose }: { value: ConsultationTypeDto | null; options: CalendarOptions; onClose: () => void }) {
  const router = useRouter();
  const [pending, startSave] = useTransition();
  const [error, setError] = useState("");
  return <form className="flex flex-col gap-4 rounded-md bg-surface-muted p-4" onSubmit={(e) => {
    e.preventDefault(); const data = new FormData(e.currentTarget);
    startSave(async () => {
      setError("");
      const result = await saveConsultationType(value?.id ?? null, {
        name: String(data.get("name")), description: String(data.get("description") ?? ""), durationMinutes: Number(data.get("duration")), bufferMinutes: Number(data.get("buffer")),
        eligibleStaffIds: data.getAll("staff").map(String), publicLabel: String(data.get("publicLabel") ?? ""), isActive: data.get("active") === "on", position: value?.position ?? 0,
      });
      if (result.ok) { router.refresh(); onClose(); } else setError(result.message);
    });
  }}>
    <h3 className="text-sm font-semibold">{value ? `Edit ${value.name}` : "New consultation type"}</h3>
    <Field label="Type name" htmlFor="type-name"><input id="type-name" name="name" defaultValue={value?.name} required maxLength={120} className={inputClasses} /></Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Duration (minutes)" htmlFor="type-duration"><input id="type-duration" name="duration" type="number" min={5} max={480} defaultValue={value?.durationMinutes ?? 30} required className={inputClasses} /></Field>
      <Field label="Buffer (minutes)" htmlFor="type-buffer"><input id="type-buffer" name="buffer" type="number" min={0} max={240} defaultValue={value?.bufferMinutes ?? 0} required className={inputClasses} /></Field>
    </div>
    <Field label="Client-facing label" htmlFor="type-public" hint="Use a generic label, such as Consultation, for future reminders."><input id="type-public" name="publicLabel" defaultValue={value?.publicLabel ?? "Consultation"} maxLength={120} className={inputClasses} /></Field>
    <Field label="Description (optional)" htmlFor="type-description"><textarea id="type-description" name="description" defaultValue={value?.description ?? ""} maxLength={500} className={inputClasses} /></Field>
    <fieldset><legend className="text-sm font-medium">Eligible staff</legend><p className="mt-1 text-xs text-ink-muted">Leave all unchecked to allow anyone.</p><div className="mt-2 flex flex-col gap-2">{options.staff.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="staff" value={s.id} defaultChecked={value?.eligibleStaffIds.includes(s.id)} />{s.fullName}</label>)}</div></fieldset>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={value?.isActive ?? true} />Active for new bookings</label>
    {error && <p role="alert" className="text-sm text-critical">{error}</p>}
    <div className="flex gap-3"><button disabled={pending} className={button}>{pending ? "Saving…" : "Save type"}</button><button type="button" disabled={pending} onClick={onClose} className={smallButton}>Cancel</button></div>
  </form>;
}

type HoursSlot = { dayOfWeek: number; startTime: string; endTime: string };
function HoursForm({ userId, hours }: { userId: string | null; hours: WorkingHoursDto[] }) {
  const router = useRouter();
  const [slots, setSlots] = useState<HoursSlot[]>(hours.map((h) => ({ dayOfWeek: h.dayOfWeek, startTime: h.startTime, endTime: h.endTime })));
  const [pending, startSave] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  function update(index: number, patch: Partial<HoursSlot>) { setSlots((current) => current.map((slot, i) => i === index ? { ...slot, ...patch } : slot)); }
  return <form className="mt-4 flex flex-col gap-4" onSubmit={(e) => {
    e.preventDefault(); startSave(async () => {
      setError(""); setMessage("");
      const result = await saveWorkingHours({ userId, slots });
      if (result.ok) { setMessage("Working hours saved."); router.refresh(); } else setError(result.message);
    });
  }}>
    {!slots.length && <p className="text-sm text-ink-muted">{userId ? "No personal hours. This staff member uses the clinic default." : "No clinic hours configured. Add a window to offer booking slots."}</p>}
    <fieldset disabled={pending} className="flex flex-col gap-3">{slots.map((slot, index) => <div key={index} className="grid grid-cols-2 items-end gap-2 rounded border border-line p-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
      <Field label="Day" htmlFor={`day-${index}`}><select id={`day-${index}`} value={slot.dayOfWeek} onChange={(e) => update(index, { dayOfWeek: Number(e.target.value) })} className={inputClasses}>{DAY_NAMES.map((name, day) => <option value={day} key={name}>{name}</option>)}</select></Field>
      <Field label="From" htmlFor={`start-${index}`}><input id={`start-${index}`} type="time" value={slot.startTime} required onChange={(e) => update(index, { startTime: e.target.value })} className={inputClasses} /></Field>
      <Field label="Until" htmlFor={`end-${index}`}><input id={`end-${index}`} type="time" value={slot.endTime} required onChange={(e) => update(index, { endTime: e.target.value })} className={inputClasses} /></Field>
      <button type="button" className="py-2 text-xs text-critical" onClick={() => setSlots((current) => current.filter((_, i) => i !== index))} aria-label={`Remove hours ${index + 1}`}>Remove</button>
    </div>)}</fieldset>
    <button type="button" disabled={pending || slots.length >= 50} className={smallButton} onClick={() => setSlots((s) => [...s, { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }])}>Add working window</button>
    <p className="text-xs text-ink-subtle">Add separate windows for breaks. Days without a window are unavailable. Remove all personal windows to use clinic defaults.</p>
    {error && <p role="alert" className="text-sm text-critical">{error}</p>}
    {message && <p role="status" className="text-sm text-positive">{message}</p>}
    <button disabled={pending} className={button}>{pending ? "Saving…" : "Save working hours"}</button>
  </form>;
}
