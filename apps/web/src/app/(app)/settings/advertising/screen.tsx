"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import {
  chooseMetaAccountAction,
  createAudienceAction,
  deleteAudienceAction,
  importLeadsAction,
  loadMetaAccountsAction,
  setBudgetAction,
  setCampaignActiveAction,
  syncAudienceAction,
  syncSpendAction,
  type AdResult,
} from "@/lib/advertising-actions";

type Platform = "meta" | "google";

export interface AdvertisingOverview {
  platforms: {
    platform: Platform;
    connected: boolean;
    accountId: string | null;
    needsAccount: boolean;
    error: string | null;
    campaigns: { id: string; name: string; status: "active" | "paused" | "other"; dailyBudgetMicros: number | null; currency: string; spend30Micros: number; leads30: number; booked30: number; won30: number }[];
  }[];
  audiences: { id: string; platform: Platform; name: string; segment: string; memberCount: number; status: string; lastError: string | null; lastSyncedAt: string | null }[];
  lastSpendSync: string | null;
}

const NAMES: Record<Platform, string> = { meta: "Facebook & Instagram", google: "Google Ads" };
const SEGMENTS: Record<string, string> = {
  marketing_consented: "Everyone who agreed to marketing",
  won: "Clients (became a paying client)",
  booked_not_won: "Booked a consultation but not yet a client",
  leads_not_booked: "Open inquiries that haven't booked",
};

const money = (micros: number | null, currency = "USD") =>
  micros === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: micros % 1_000_000 === 0 ? 0 : 2 }).format(micros / 1_000_000);
const per = (micros: number, n: number, currency: string) => (n ? money(Math.round(micros / n), currency) : "—");

function useAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<AdResult | null>(null);
  const run = (fn: () => Promise<AdResult>) => start(async () => setResult(await fn()));
  return { pending, result, run };
}

function Outcome({ result }: { result: AdResult | null }) {
  if (!result) return null;
  return <p role={result.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-positive-soft text-positive" : "bg-critical-soft text-critical"}`}>{result.ok ? result.detail ?? "Done." : result.message}</p>;
}

export function AdvertisingScreen({ data, writable }: { data: AdvertisingOverview; writable: boolean }) {
  const { pending, result, run } = useAction();
  const connected = data.platforms.filter((p) => p.connected);

  return (
    <div className="flex flex-col gap-5">
      {connected.length === 0 && (
        <p className="rounded-card border border-line bg-surface p-5 text-sm">
          Connect your ad accounts first under <Link href="/settings/integrations" className="font-medium text-brand">Lead sources &amp; messaging</Link> — Connect with Facebook and Connect with Google Ads.
        </p>
      )}
      <Outcome result={result} />

      {data.platforms.map((p) => p.connected && (
        <section key={p.platform} className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
          <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">{NAMES[p.platform]}</h2>
              <p className="text-sm text-ink-muted">Last 30 days. Spend from the ad platform; leads, bookings and clients from SkinCRM.</p>
            </div>
            {writable && !p.needsAccount && <button type="button" disabled={pending} onClick={() => run(() => syncSpendAction(p.platform))} className={buttonClasses("secondary", "sm")}>Refresh spend</button>}
          </header>
          {p.needsAccount ? (
            <ChooseMetaAccount writable={writable} />
          ) : p.error ? (
            <p role="alert" className="text-sm text-critical">{p.error}</p>
          ) : p.campaigns.length === 0 ? (
            <p className="text-sm text-ink-muted">No campaigns in this account.</p>
          ) : (
            <div className="-mx-5 overflow-x-auto">
              <table className="stack-table w-full text-sm">
                <caption className="sr-only">{NAMES[p.platform]} campaigns</caption>
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-subtle">
                    <th scope="col" className="px-5 py-2 font-medium">Campaign</th>
                    <th scope="col" className="px-3 py-2 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Daily budget</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Spend</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Leads</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Per booking</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Per client</th>
                    {writable && <th scope="col" className="px-5 py-2"><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {p.campaigns.map((c) => <CampaignRow key={c.id} platform={p.platform} c={c} writable={writable} run={run} pending={pending} />)}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      {connected.length > 0 && <Audiences data={data} platforms={connected.filter((p) => !p.needsAccount).map((p) => p.platform)} writable={writable} />}
      {connected.length > 0 && writable && <ImportHistory platforms={connected.filter((p) => !p.needsAccount || p.platform === "meta").map((p) => p.platform)} />}
    </div>
  );
}

function CampaignRow({ platform, c, writable, run, pending }: {
  platform: Platform;
  c: AdvertisingOverview["platforms"][number]["campaigns"][number];
  writable: boolean;
  run: (fn: () => Promise<AdResult>) => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <tr className="border-b border-line last:border-0 align-top">
      <td className="px-5 py-3 font-medium">{c.name}</td>
      <td data-label="Status" className="px-3 py-3">{c.status === "active" ? <Badge tone="positive">Running</Badge> : c.status === "paused" ? <Badge>Paused</Badge> : <Badge tone="caution">Other</Badge>}</td>
      <td data-label="Daily budget" className="px-3 py-3 text-right tabular-nums">
        {editing ? (
          <form className="flex justify-end gap-1" onSubmit={(e) => {
            e.preventDefault();
            const value = Number(new FormData(e.currentTarget).get("budget"));
            const before = (c.dailyBudgetMicros ?? 0) / 1_000_000;
            if (value > before * 2 && !window.confirm(`Raise the daily budget from ${money(c.dailyBudgetMicros, c.currency)} to ${money(value * 1_000_000, c.currency)}? Spend starts at the new rate right away.`)) return;
            run(async () => { const r = await setBudgetAction(platform, c.id, value); if (r.ok) setEditing(false); return r; });
          }}>
            <label htmlFor={`b-${c.id}`} className="sr-only">Daily budget for {c.name}</label>
            <input id={`b-${c.id}`} name="budget" type="number" min={1} max={10000} step="0.01" defaultValue={(c.dailyBudgetMicros ?? 0) / 1_000_000} className={`${inputClasses} w-24 py-1.5`} autoFocus />
            <button disabled={pending} className={buttonClasses("primary", "sm")}>Save</button>
          </form>
        ) : (
          <>
            {money(c.dailyBudgetMicros, c.currency)}
            {c.dailyBudgetMicros === null && <span className="block text-xs text-ink-subtle">On ad sets / shared</span>}
          </>
        )}
      </td>
      <td data-label="Spend" className="px-3 py-3 text-right tabular-nums">{money(c.spend30Micros, c.currency)}</td>
      <td data-label="Leads" className="px-3 py-3 text-right tabular-nums">{c.leads30}</td>
      <td data-label="Per booking" className="px-3 py-3 text-right tabular-nums">{per(c.spend30Micros, c.booked30, c.currency)}</td>
      <td data-label="Per client" className="px-3 py-3 text-right tabular-nums">{per(c.spend30Micros, c.won30, c.currency)}</td>
      {writable && (
        <td className="px-5 py-3">
          <div className="flex justify-end gap-1">
            {c.status !== "other" && (
              <button type="button" disabled={pending} className={buttonClasses("secondary", "sm")}
                onClick={() => { if (c.status === "paused" || window.confirm(`Pause "${c.name}"? Its ads stop showing within minutes.`)) run(() => setCampaignActiveAction(platform, c.id, c.status === "paused")); }}>
                {c.status === "paused" ? "Resume" : "Pause"}
              </button>
            )}
            {c.dailyBudgetMicros !== null && !editing && <button type="button" onClick={() => setEditing(true)} className={buttonClasses("ghost", "sm")}>Budget</button>}
          </div>
        </td>
      )}
    </tr>
  );
}

function ChooseMetaAccount({ writable }: { writable: boolean }) {
  const [accounts, setAccounts] = useState<{ id: string; name: string; currency: string }[] | null>(null);
  const { pending, result, run } = useAction();
  if (!writable) return <p className="text-sm text-ink-muted">An admin needs to choose which Facebook ad account to use.</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">Which ad account runs the clinic&rsquo;s ads?</p>
      {accounts === null ? (
        <div><button type="button" disabled={pending} onClick={() => run(async () => { const r = await loadMetaAccountsAction(); if (r.ok) { setAccounts(r.items); return { ok: true, detail: `${r.items.length} ad ${r.items.length === 1 ? "account" : "accounts"} found.` }; } return r; })} className={buttonClasses()}>Show my ad accounts</button></div>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); run(() => chooseMetaAccountAction(String(new FormData(e.currentTarget).get("account")))); }}>
          <div className="min-w-64"><Field label="Ad account" htmlFor="meta-account"><select id="meta-account" name="account" className={inputClasses}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}</select></Field></div>
          <button disabled={pending} className={buttonClasses()}>Use this account</button>
        </form>
      )}
      <Outcome result={result} />
    </div>
  );
}

function Audiences({ data, platforms, writable }: { data: AdvertisingOverview; platforms: Platform[]; writable: boolean }) {
  const { pending, result, run } = useAction();
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-base font-semibold">Audiences</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Customer lists on Facebook or Google, kept in step daily — to show ads to past clients, or exclude people who already booked.
        Only people who agreed to marketing from the clinic are included, as scrambled (hashed) email and phone; never names, treatments or notes.
      </p>
      {data.audiences.length > 0 && (
        <ul className="mt-4 flex flex-col divide-y divide-line rounded-lg border border-line">
          {data.audiences.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <div className="mr-auto min-w-0">
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-ink-muted">{NAMES[a.platform]} · {SEGMENTS[a.segment] ?? a.segment} · {a.memberCount} people{a.lastSyncedAt ? ` · updated ${new Date(a.lastSyncedAt).toLocaleString()}` : ""}</p>
                {a.lastError && <p className="text-xs text-critical">{a.lastError}</p>}
              </div>
              {a.status === "error" ? <Badge tone="critical">Needs attention</Badge> : <Badge tone="positive">In step</Badge>}
              {writable && <button type="button" disabled={pending} onClick={() => run(() => syncAudienceAction(a.id))} className={buttonClasses("secondary", "sm")}>Update now</button>}
              {writable && <button type="button" disabled={pending} onClick={() => { if (window.confirm(`Delete "${a.name}" from ${NAMES[a.platform]}? Ads using it will stop reaching these people.`)) run(() => deleteAudienceAction(a.id)); }} className={buttonClasses("danger", "sm")}>Delete</button>}
            </li>
          ))}
        </ul>
      )}
      {writable && platforms.length > 0 && (
        <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1.2fr_auto] sm:items-end" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          run(() => createAudienceAction({ platform: String(f.get("platform")) as Platform, segment: String(f.get("segment")), name: String(f.get("name")) }));
        }}>
          <Field label="Platform" htmlFor="aud-platform"><select id="aud-platform" name="platform" className={inputClasses}>{platforms.map((p) => <option key={p} value={p}>{NAMES[p]}</option>)}</select></Field>
          <Field label="Who" htmlFor="aud-segment"><select id="aud-segment" name="segment" className={inputClasses}>{Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Name" htmlFor="aud-name"><input id="aud-name" name="name" required minLength={2} maxLength={120} placeholder="e.g. Past clients — exclude" className={inputClasses} /></Field>
          <button disabled={pending} className={buttonClasses()}>{pending ? "Creating…" : "Create audience"}</button>
        </form>
      )}
      <div className="mt-3"><Outcome result={result} /></div>
    </section>
  );
}

function ImportHistory({ platforms }: { platforms: Platform[] }) {
  const { pending, result, run } = useAction();
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-base font-semibold">Import past leads</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Bring in lead-form submissions from before you connected (up to 90 days). They keep their original date, skip anyone already in SkinCRM,
        and don&rsquo;t send welcome messages or alerts. Past WhatsApp chats arrive automatically for a number connected with &ldquo;the number we already use&rdquo;.
      </p>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(() => importLeadsAction(String(f.get("platform")) as Platform, Number(f.get("days"))));
      }}>
        <div className="min-w-48"><Field label="From" htmlFor="imp-platform"><select id="imp-platform" name="platform" className={inputClasses}>{platforms.map((p) => <option key={p} value={p}>{NAMES[p]}</option>)}</select></Field></div>
        <div className="w-40"><Field label="How far back" htmlFor="imp-days"><select id="imp-days" name="days" defaultValue="30" className={inputClasses}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></Field></div>
        <button disabled={pending} className={buttonClasses()}>{pending ? "Importing…" : "Import"}</button>
      </form>
      <div className="mt-3"><Outcome result={result} /></div>
    </section>
  );
}
