"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { PublicAppointment, PublicBookingInfo } from "@skincrm/contracts";
import { EmailInput, NameInput, PhoneInput } from "@/components/contact-inputs";
import { SlotPicker, formatDay, formatTime } from "@/components/slot-picker";
import { Field, buttonClasses, inputClasses } from "@/components/ui";
import { bookAction, bookingSlotsAction } from "@/lib/booking-actions";

/**
 * Three steps on one page: what, when, who. Nothing is held while the patient
 * fills in their details; if someone takes the time first, they are told
 * plainly and picked times refresh.
 */
export function BookingFlow({ slug, info }: { slug: string; info: PublicBookingInfo }) {
  const [typeId, setTypeId] = useState(info.types.length === 1 ? info.types[0]!.id : "");
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [done, setDone] = useState<PublicAppointment | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [pending, start] = useTransition();
  const tz = info.timezone;

  if (done) {
    return (
      <section aria-labelledby="done-title" className="rounded-card border border-line bg-surface p-6">
        <h2 id="done-title" className="text-lg font-semibold">You&rsquo;re booked in</h2>
        <p className="mt-2 text-[15px]">
          {done.typeName ?? "Appointment"} on <strong>{formatDay(done.startsAt, tz)}</strong> at <strong>{formatTime(done.startsAt, tz)}</strong> at {done.clinicName}.
        </p>
        <p className="mt-2 text-sm text-ink-muted">We&rsquo;ll send a confirmation and a reminder. To change or cancel, use this link (keep it — it&rsquo;s also in your confirmation):</p>
        <Link href={`/appointment/${done.manageToken}`} className="mt-3 inline-block text-sm font-medium text-brand">Manage my appointment</Link>
      </section>
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!startsAt) return setError("Choose a time first.");
        const f = new FormData(e.currentTarget);
        const text = (k: string) => String(f.get(k) ?? "").trim() || null;
        start(async () => {
          setError(null);
          setFieldErrors({});
          const r = await bookAction(slug, {
            typeId, startsAt,
            firstName: text("firstName"), lastName: text("lastName"), phone: text("phone"), email: text("email"), note: text("note"),
            contactConsent: f.get("contactConsent") === "on", marketingConsent: f.get("marketingConsent") === "on",
            website: text("website") ?? undefined,
          });
          if (r.ok) return setDone(r.data);
          setError(r.message);
          setFieldErrors(r.fieldErrors ?? {});
          if (/taken/.test(r.message)) { setStartsAt(null); setPickerKey((k) => k + 1); }
        });
      }}
    >
      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="text-base font-semibold">1. What would you like to book?</h2>
        <div className="mt-3 flex flex-col gap-2">
          {info.types.map((t) => (
            <label key={t.id} className={`flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 ${typeId === t.id ? "border-brand bg-brand-soft" : "border-line-strong hover:bg-surface-muted"}`}>
              <span className="flex items-center gap-3">
                <input type="radio" name="type" value={t.id} checked={typeId === t.id} onChange={() => { setTypeId(t.id); setStartsAt(null); }} />
                <span className="font-medium">{t.name}</span>
              </span>
              <span className="text-sm text-ink-muted">{t.durationMinutes} min</span>
            </label>
          ))}
        </div>
      </section>

      {typeId && (
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="mb-3 text-base font-semibold">2. When?</h2>
          <SlotPicker key={`${typeId}-${pickerKey}`} timezone={tz} value={startsAt} onChange={setStartsAt} load={(date) => bookingSlotsAction(slug, typeId, date)} />
        </section>
      )}

      {startsAt && (
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-base font-semibold">3. Your details</h2>
          <p className="mt-1 text-sm text-ink-muted">{formatDay(startsAt, tz)} at {formatTime(startsAt, tz)}</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="First name" htmlFor="b-first" errors={fieldErrors.firstName}><NameInput id="b-first" name="firstName" required autoComplete="given-name" /></Field>
            <Field label="Last name" htmlFor="b-last" errors={fieldErrors.lastName}><NameInput id="b-last" name="lastName" autoComplete="family-name" /></Field>
            <Field label="Mobile" htmlFor="b-phone" errors={fieldErrors.phone}><PhoneInput id="b-phone" name="phone" /></Field>
            <Field label="Email" htmlFor="b-email" errors={fieldErrors.email}><EmailInput id="b-email" name="email" /></Field>
            <div className="sm:col-span-2">
              <Field label="Anything we should know? (optional)" htmlFor="b-note" hint="Please don't include medical details here." errors={fieldErrors.note}>
                <textarea id="b-note" name="note" rows={2} maxLength={1000} className={inputClasses} />
              </Field>
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-subtle">A mobile number or an email is enough.</p>
          {/* Honeypot: hidden from people, irresistible to bots. */}
          <div aria-hidden="true" className="absolute -left-[9999px]">
            <label htmlFor="b-website">Website</label>
            <input id="b-website" name="website" tabIndex={-1} autoComplete="off" />
          </div>
          <div className="mt-4 flex flex-col gap-2 text-sm">
            <label className="flex items-start gap-2"><input type="checkbox" name="contactConsent" required className="mt-1" /> <span>Send me a confirmation and reminders about this appointment.</span></label>
            <label className="flex items-start gap-2"><input type="checkbox" name="marketingConsent" className="mt-1" /> <span>Also send me news and offers from {info.clinicName}. <span className="text-ink-subtle">(Optional — you can stop any time.)</span></span></label>
          </div>
          {error && <p role="alert" className="mt-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{error}</p>}
          <div className="mt-4">
            <button disabled={pending} className={buttonClasses()}>{pending ? "Booking…" : "Book appointment"}</button>
          </div>
          <p className="mt-3 text-xs text-ink-subtle">By booking you agree to our <Link href="/privacy" className="underline">privacy notice</Link>.</p>
        </section>
      )}
      {!startsAt && error && <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{error}</p>}
    </form>
  );
}
