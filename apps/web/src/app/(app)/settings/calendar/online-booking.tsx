"use client";

import { useState, useTransition } from "react";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import { CopyField } from "../integrations/cards";
import { saveOnlineBookingAction } from "@/lib/calendar-settings-actions";

export interface OnlineBookingSettings {
  enabled: boolean;
  cutoffHours: number;
  url: string;
  types: { id: string; name: string; bookableOnline: boolean }[];
}

/**
 * Settings → Calendar → Online booking (D-92): switch the public page on, pick
 * which appointment types patients may book, and how close to the time they
 * can still move or cancel online.
 */
export function OnlineBookingCard({ settings }: { settings: OnlineBookingSettings }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Online booking</h2>
          <p className="mt-1 text-sm text-ink-muted">A page where patients book themselves, plus a link in every confirmation and reminder to move or cancel.</p>
        </div>
        {settings.enabled ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge>}
      </header>
      <form className="flex flex-col gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const r = await saveOnlineBookingAction({
            enabled: f.get("enabled") === "on",
            cutoffHours: Number(f.get("cutoff") ?? 24),
            bookableTypeIds: f.getAll("types").map(String),
          });
          setResult(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.message });
        });
      }}>
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="enabled" defaultChecked={settings.enabled} /> Patients can book online</label>
        <fieldset>
          <legend className="text-sm font-medium">Appointment types patients can book</legend>
          {settings.types.length === 0 ? (
            <p className="mt-1 text-sm text-ink-muted">Add a consultation type above first.</p>
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              {settings.types.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="types" value={t.id} defaultChecked={t.bookableOnline} /> {t.name}</label>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-ink-subtle">Bookings go to the type&rsquo;s chosen staff, or to practitioners if none are chosen — whoever has the lightest day.</p>
        </fieldset>
        <div className="max-w-xs">
          <Field label="Online changes close" htmlFor="ob-cutoff" hint="Hours before the appointment. After that, patients are asked to call.">
            <input id="ob-cutoff" name="cutoff" type="number" min={0} max={168} defaultValue={settings.cutoffHours} className={inputClasses} />
          </Field>
        </div>
        <CopyField label="Booking page — put this on your website and social profiles" value={settings.url} />
        <p className="text-xs text-ink-subtle">Add <code>{"{{link.reschedule}}"}</code> to your confirmation and reminder templates so patients get their manage link.</p>
        <div><button disabled={pending} className={buttonClasses()}>{pending ? "Saving…" : "Save"}</button></div>
        {result && <p role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "text-positive" : "text-critical"}`}>{result.text}</p>}
      </form>
    </section>
  );
}
