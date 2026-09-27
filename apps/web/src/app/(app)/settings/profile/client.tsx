"use client";

import { useState, useTransition } from "react";
import { PASSWORD_MIN_LENGTH } from "@skincrm/contracts";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import {
  changePasswordAction,
  confirmMfaAction,
  disableMfaAction,
  saveMyNameAction,
  startMfaAction,
  type ProfileResult,
} from "@/lib/profile-actions";

function Outcome({ result }: { result: ProfileResult | null }) {
  if (!result) return null;
  return result.ok
    ? <p role="status" className="text-sm text-positive">{result.detail ?? "Saved."}</p>
    : <p role="alert" className="text-sm text-critical">{result.message}</p>;
}

function Section({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-base font-semibold">{title}</h2>
      {intro && <p className="mt-0.5 text-sm text-ink-muted">{intro}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function MyProfile({ name, email, role, mfaEnabled, mustEnableMfa, isAdmin }: {
  name: string; email: string; role: string; mfaEnabled: boolean; mustEnableMfa: boolean; isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [nameResult, setNameResult] = useState<ProfileResult | null>(null);
  const [pwResult, setPwResult] = useState<ProfileResult | null>(null);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Section title="About you">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); const n = String(new FormData(e.currentTarget).get("name")).trim(); start(async () => setNameResult(await saveMyNameAction(n))); }}>
          <Field label="Your name" htmlFor="p-name" hint="How colleagues and the activity log see you."><input id="p-name" name="name" required defaultValue={name} className={inputClasses} /></Field>
          <div className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <span className="text-ink-muted">Email</span><span>{email}</span>
            <span className="text-ink-muted">Role</span><span>{role}</span>
          </div>
          <p className="text-xs text-ink-subtle">To change your email or role, ask an admin (Settings → Staff).</p>
          <div><button disabled={pending} className={buttonClasses("primary")}>Save</button></div>
          <Outcome result={nameResult} />
        </form>
      </Section>

      <Section title="Password" intro="Changing it signs you out everywhere, including here.">
        <form className="flex flex-col gap-4" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (f.get("next") !== f.get("again")) return setPwResult({ ok: false, message: "The two new passwords don't match." });
          start(async () => setPwResult(await changePasswordAction(String(f.get("current")), String(f.get("next")))));
        }}>
          <Field label="Current password" htmlFor="pw-cur"><input id="pw-cur" name="current" type="password" autoComplete="current-password" required className={inputClasses} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New password" htmlFor="pw-new" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}><input id="pw-new" name="next" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required className={inputClasses} /></Field>
            <Field label="New password again" htmlFor="pw-again"><input id="pw-again" name="again" type="password" autoComplete="new-password" required className={inputClasses} /></Field>
          </div>
          <div><button disabled={pending} className={buttonClasses("secondary")}>Change password</button></div>
          <Outcome result={pwResult} />
        </form>
      </Section>

      <TwoStep enabled={mfaEnabled} highlight={mustEnableMfa || (isAdmin && !mfaEnabled)} />
    </div>
  );
}

function TwoStep({ enabled, highlight }: { enabled: boolean; highlight: boolean }) {
  const [pending, start] = useTransition();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<ProfileResult | null>(null);

  return (
    <Section title="Two-step sign-in" intro="After your password, you also type a 6-digit code from an app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…). Strongly recommended — required for admins.">
      <div className="mb-3">{enabled || codes ? <Badge tone="positive">On</Badge> : <Badge tone={highlight ? "critical" : "neutral"}>Off</Badge>}</div>

      {codes ? (
        <div className="rounded-lg border border-caution/50 bg-caution-soft p-4">
          <p className="text-sm font-medium">It&rsquo;s on. Save these backup codes now — each works once if you lose your phone. They won&rsquo;t be shown again.</p>
          <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-3">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))} className={`${buttonClasses("secondary", "sm")} mt-3`}>Copy codes</button>
        </div>
      ) : enabled ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const p = String(new FormData(e.currentTarget).get("pw")); start(async () => setOff(await disableMfaAction(p))); }}>
          <Field label="Your password, to turn it off" htmlFor="mfa-pw"><input id="mfa-pw" name="pw" type="password" autoComplete="current-password" required className={inputClasses} /></Field>
          <button disabled={pending} className={buttonClasses("danger")}>Turn off</button>
          <div className="w-full"><Outcome result={off} /></div>
        </form>
      ) : setup ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get("code")).replace(/\s/g, "");
          start(async () => { const r = await confirmMfaAction(code); if (r.ok) setCodes(r.recoveryCodes); else setError(r.message); });
        }}>
          <ol className="flex flex-col gap-2 text-sm">
            <li>1. Open your authenticator app and add an account by scanning this code.</li>
            <li>2. Type the 6-digit code it shows.</li>
          </ol>
          <div className="flex flex-wrap items-start gap-4">
            <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded-lg border border-line" />
            <div className="text-sm">
              <p className="text-ink-muted">Can&rsquo;t scan? Enter this key instead:</p>
              <code className="mt-1 block break-all rounded bg-surface-muted px-2 py-1">{setup.secret}</code>
            </div>
          </div>
          <Field label="6-digit code" htmlFor="mfa-code"><input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required className={`${inputClasses} max-w-40 tracking-widest`} /></Field>
          {error && <p role="alert" className="text-sm text-critical">{error}</p>}
          <div><button disabled={pending} className={buttonClasses("primary")}>Turn on</button></div>
        </form>
      ) : (
        <>
          <button type="button" disabled={pending} onClick={() => start(async () => { const r = await startMfaAction(); if (r.ok) setSetup(r); else setError(r.message); })} className={buttonClasses("primary")}>
            Set up two-step sign-in
          </button>
          {error && <p role="alert" className="mt-2 text-sm text-critical">{error}</p>}
        </>
      )}
    </Section>
  );
}
