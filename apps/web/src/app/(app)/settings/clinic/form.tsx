"use client";

import { useRef, useState, useTransition } from "react";
import { LOGO_MAX_BYTES } from "@skincrm/contracts";
import { Field, buttonClasses, inputClasses } from "@/components/ui";
import { removeLogoAction, saveClinicAction, uploadLogoAction, type ProfileResult } from "@/lib/profile-actions";
import type { ClinicSettings } from "./page";

const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico", "Europe/London", "Asia/Kolkata", "Asia/Dubai", "Australia/Sydney",
];

function Outcome({ result }: { result: ProfileResult | null }) {
  if (!result) return null;
  return result.ok
    ? <p role="status" className="text-sm text-positive">{result.detail ?? "Saved."}</p>
    : <p role="alert" className="text-sm text-critical">{result.message}</p>;
}

export function ClinicForm({ clinic, writable }: { clinic: ClinicSettings; writable: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [logoResult, setLogoResult] = useState<ProfileResult | null>(null);
  const [preview, setPreview] = useState<string | null>(clinic.logoVersion ? `/clinic-logo?v=${clinic.logoVersion}` : null);
  const file = useRef<HTMLInputElement>(null);
  const errors = result && !result.ok ? result.fieldErrors : undefined;
  const zones = TIMEZONES.includes(clinic.timezone) ? TIMEZONES : [clinic.timezone, ...TIMEZONES];

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) return setLogoResult({ ok: false, message: "Use a PNG, JPG or WebP image." });
    if (f.size > LOGO_MAX_BYTES) return setLogoResult({ ok: false, message: "That image is over 512 KB. Use a smaller version." });
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setPreview(dataUrl);
      start(async () => setLogoResult(await uploadLogoAction(dataUrl)));
    };
    reader.readAsDataURL(f);
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
        <h2 className="text-base font-semibold">Logo</h2>
        <p className="mt-0.5 text-sm text-ink-muted">Shown at the top of the menu for everyone on your team. PNG, JPG or WebP, up to 512 KB. A square image works best.</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-muted">
            {preview ? (
              <img src={preview} alt={`${clinic.name} logo`} className="h-full w-full object-contain" />
            ) : (
              <span className="text-xs text-ink-subtle">No logo</span>
            )}
          </div>
          {writable && (
            <div className="flex flex-wrap gap-2">
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" id="logo-file" onChange={(e) => pick(e.target.files?.[0])} />
              <label htmlFor="logo-file" className={`${buttonClasses("secondary")} cursor-pointer`}>{preview ? "Change logo" : "Upload logo"}</label>
              {preview && (
                <button type="button" disabled={pending} onClick={() => start(async () => { const r = await removeLogoAction(); setLogoResult(r); if (r.ok) setPreview(null); })} className={buttonClasses("ghost")}>
                  Remove
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-2"><Outcome result={logoResult} /></div>
      </section>

      <form
        className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const v = (k: string) => String(f.get(k) ?? "").trim() || null;
          start(async () => setResult(await saveClinicAction({
            name: String(f.get("name") ?? "").trim(),
            phone: v("phone"),
            website: v("website"),
            supportEmail: v("supportEmail"),
            postalAddress: v("postalAddress"),
            timezone: String(f.get("timezone")),
          })));
        }}
      >
        <h2 className="text-base font-semibold">Details</h2>
        <fieldset disabled={!writable || pending} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Clinic name" htmlFor="c-name" errors={errors?.name}><input id="c-name" name="name" required defaultValue={clinic.name} className={inputClasses} /></Field>
          </div>
          <Field label="Phone" htmlFor="c-phone" hint="Used in messages as the number to call."><input id="c-phone" name="phone" type="tel" defaultValue={clinic.phone ?? ""} className={inputClasses} /></Field>
          <Field label="Contact email" htmlFor="c-email" errors={errors?.supportEmail}><input id="c-email" name="supportEmail" type="email" defaultValue={clinic.supportEmail ?? ""} className={inputClasses} /></Field>
          <Field label="Website" htmlFor="c-web"><input id="c-web" name="website" defaultValue={clinic.website ?? ""} placeholder="https://" className={inputClasses} /></Field>
          <Field label="Time zone" htmlFor="c-tz" hint="All times in the CRM use this.">
            <select id="c-tz" name="timezone" defaultValue={clinic.timezone} className={inputClasses}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Postal address" htmlFor="c-addr" hint="Required on marketing emails by law."><input id="c-addr" name="postalAddress" defaultValue={clinic.postalAddress ?? ""} className={inputClasses} /></Field>
          </div>
        </fieldset>
        {writable && <div><button disabled={pending} className={buttonClasses("primary")}>{pending ? "Saving…" : "Save"}</button></div>}
        <Outcome result={result} />
      </form>
    </div>
  );
}
