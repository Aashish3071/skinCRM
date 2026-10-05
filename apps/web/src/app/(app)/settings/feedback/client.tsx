"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  FEEDBACK_MILESTONES,
  FEEDBACK_MILESTONE_LABELS,
  forbiddenWordIn,
  type FeedbackAssets,
  type FeedbackDestinationDto,
  type FeedbackEventDto,
  type FeedbackMapping,
  type FeedbackPreview,
} from "@skincrm/contracts";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import {
  applyGoogleConnectionAction,
  applyMetaConnectionAction,
  applyWhatsAppConnectionAction,
  loadFeedbackAssetsAction,
  confirmChecklistAction,
  connectFeedbackAction,
  goLiveAction,
  markBlockedAction,
  pauseFeedbackAction,
  previewFeedbackAction,
  revokeFeedbackAction,
  retryFeedbackAction,
  saveMappingAction,
  testFeedbackAction,
  type FbResult,
} from "@/lib/feedback-actions";

const NAMES = { meta: "Facebook & Instagram (Meta)", google: "Google Ads" } as const;

function Outcome({ result }: { result: FbResult | null }) {
  if (!result) return null;
  return result.ok
    ? <p role="status" className="text-sm text-positive">{result.detail ?? "Done."}</p>
    : <p role="alert" className="text-sm text-critical">{result.message}</p>;
}

function statusBadge(d: FeedbackDestinationDto) {
  if (d.paused) return <Badge tone="caution">Paused</Badge>;
  switch (d.eligibility) {
    case "approved_production": return <Badge tone="positive">Live</Badge>;
    case "approved_test_only": return <Badge tone="brand">Test only</Badge>;
    case "blocked_by_policy": return <Badge tone="critical">Not allowed</Badge>;
    default: return <Badge>Off</Badge>;
  }
}

/** Folds the pasted-credentials form away when a connected account can be used instead. */
function Collapsible({ collapsed, summary, children }: { collapsed: boolean; summary: string; children: React.ReactNode }) {
  if (!collapsed) return <>{children}</>;
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">{summary}</summary>
      {children}
    </details>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-t border-line pt-4">
      <span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-positive-soft text-positive" : "bg-surface-muted text-ink-muted"}`}>
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">{title}{done && <span className="sr-only"> (done)</span>}</h3>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

export function DestinationCard({ dest, writable, demo, volume, googleAds = null }: {
  dest: FeedbackDestinationDto;
  /** The account from "Connect with Google Ads", offered instead of pasted credentials. */
  googleAds?: { customerId: string; name: string } | null;
  writable: boolean;
  demo: boolean;
  volume: { milestone: string; state: string; n: number }[];
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FbResult | null>(null);
  const [mapping, setMapping] = useState<FeedbackMapping>(dest.mapping);
  const [wa, setWa] = useState(dest.includeWhatsAppAds);
  const [whatsappTestCode, setWhatsappTestCode] = useState("");
  const [assets, setAssets] = useState<FeedbackAssets | null>(null);
  const [datasetId, setDatasetId] = useState("");
  const [testCode, setTestCode] = useState("");
  const [checks, setChecks] = useState([false, false, false]);
  const [preview, setPreview] = useState<(FeedbackPreview & { basedOn: string }) | null>(null);
  const d = dest.destination;
  const act = (fn: () => Promise<FbResult>) => start(async () => setResult(await fn()));
  const mapped = FEEDBACK_MILESTONES.some((m) => dest.mapping[m].enabled);
  const reviewed = dest.eligibility === "approved_test_only" || dest.eligibility === "approved_production";
  const testsPassed = (d !== "meta" || dest.accountLabel ? dest.lastTestOk === true : true) && (!dest.includeWhatsAppAds || dest.whatsappTestOk === true);
  const accepted = (m: string) => volume.filter((v) => v.milestone === m && v.state === "accepted").reduce((a, v) => a + v.n, 0);
  const badName = FEEDBACK_MILESTONES.map((m) => (mapping[m].enabled ? forbiddenWordIn(mapping[m].eventName) : null)).find(Boolean);

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby={`fb-${d}`}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`fb-${d}`} className="text-base font-semibold">{NAMES[d]}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {d === "meta"
              ? "Bookings and client outcomes from Facebook/Instagram lead forms and click-to-WhatsApp ads."
              : "For leads from Google Ads that arrived with a click ID. Click ID only — no emails or phone numbers."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {statusBadge(dest)}
          {writable && reviewed && (
            <button type="button" disabled={pending} onClick={() => act(() => pauseFeedbackAction(d, !dest.paused))} className={buttonClasses(dest.paused ? "primary" : "danger", "sm")}>
              {dest.paused ? "Resume" : "Pause all"}
            </button>
          )}
        </div>
      </header>

      {demo && <p className="mb-4 rounded-lg bg-surface-muted p-3 text-sm text-ink-muted">Demo connection: events stay in this CRM. Nothing is sent to the ad platforms.</p>}
      <div className="flex flex-col gap-4">
        <Step n={1} title="Choose the conversion destination" done={dest.connected}>
          {writable && (
            <div className="mb-3 flex flex-col gap-3 rounded-lg border border-line p-3">
              <p className="text-sm text-ink-muted">Use accounts already connected under <Link href="/settings/integrations" className="font-medium text-brand">Lead sources &amp; messaging</Link>.</p>
              <div><button type="button" disabled={pending} onClick={() => act(async () => {
                const loaded = await loadFeedbackAssetsAction();
                if (!loaded.ok) return loaded;
                setAssets(loaded.assets);
                setDatasetId(loaded.assets.metaDatasets[0]?.id ?? "");
                return { ok: true, detail: "Connected accounts loaded." };
              })} className={buttonClasses("secondary", "sm")}>{assets ? "Refresh connected accounts" : "Load connected accounts"}</button></div>
              {assets?.errors.filter((e) => e.channel === d).map((e) => <p key={e.channel} role="alert" className="text-sm text-critical">{e.message}</p>)}
              {d === "meta" && assets && <>
                <Field label="Meta test event code" htmlFor="linked-meta-test" hint="From Events Manager → Test events. Used only in test mode."><input id="linked-meta-test" value={testCode} onChange={(e) => setTestCode(e.target.value)} className={inputClasses} /></Field>
                {assets.metaDatasets.length > 0 && <div className="flex flex-wrap items-end gap-2">
                  <Field label="Facebook / Instagram dataset" htmlFor="linked-meta-dataset"><select id="linked-meta-dataset" value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className={inputClasses}>{assets.metaDatasets.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.businessName}</option>)}</select></Field>
                  <button type="button" disabled={pending || !datasetId} onClick={() => act(() => applyMetaConnectionAction(datasetId, testCode))} className={buttonClasses("primary", "sm")}>Use this dataset</button>
                </div>}
                {assets.metaConnected && !assets.metaDatasets.length && !assets.errors.some((e) => e.channel === "meta") && <p className="text-sm text-ink-muted">No datasets are shared with this Facebook connection. Share the CRM dataset in Meta Business Settings, then refresh.</p>}
                {assets.whatsappConnected && <Field label="WhatsApp test event code" htmlFor="linked-whatsapp-test" hint="From the WhatsApp dataset’s Test events tab. Saved separately from the Facebook dataset code."><input id="linked-whatsapp-test" value={whatsappTestCode} onChange={(e) => setWhatsappTestCode(e.target.value)} className={inputClasses} /></Field>}
                {assets.whatsappConnected && <div className="flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-ink-muted">Use the connected WhatsApp business number for ad outcomes.</p><button type="button" disabled={pending} onClick={() => act(() => applyWhatsAppConnectionAction(whatsappTestCode))} className={buttonClasses("primary", "sm")}>Connect WhatsApp outcomes</button></div>}
                {dest.whatsappConnected && <p className="text-sm text-positive">WhatsApp dataset connected: {dest.whatsappDatasetId}</p>}
              </>}
              {d === "google" && assets?.googleConnected && <button type="button" disabled={pending} onClick={() => act(() => applyGoogleConnectionAction())} className={buttonClasses("primary", "sm")}>Use connected Google Ads account</button>}
            </div>
          )}
          {dest.connected ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-ink-muted">{d === "meta" ? "Dataset" : "Customer ID"}: {dest.accountLabel}{d === "meta" && (dest.hasTestEventCode ? " · test code set" : " · no test code")}</span>
              {writable && <button type="button" disabled={pending} onClick={() => { if (window.confirm("Disconnect? Stored credentials are deleted and anything waiting is cancelled.")) act(() => revokeFeedbackAction(d)); }} className={buttonClasses("ghost", "sm")}>Disconnect</button>}
            </div>
          ) : writable ? (
            <>
            {d === "google" && (googleAds ? (
              <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-brand bg-brand-soft p-3 text-sm">
                <p className="mr-auto">Use <strong>{googleAds.name}</strong> ({googleAds.customerId.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}), already connected for lead forms.</p>
                <button type="button" disabled={pending} onClick={() => act(() => applyGoogleConnectionAction())} className={buttonClasses("primary", "sm")}>Use this account</button>
              </div>
            ) : (
              <p className="mb-3 text-sm text-ink-muted">
                Easiest: <Link href="/settings/integrations" className="font-medium text-brand">Connect with Google Ads</Link> under Lead sources, then come back — nothing to paste. Or enter the details below.
              </p>
            ))}
            <Collapsible collapsed={d === "google" && Boolean(googleAds)} summary="Enter different credentials by hand">
            <form className="mt-2 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; act(() => connectFeedbackAction(d, f)); }}>
              {d === "meta" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Dataset (pixel) ID" htmlFor="fb-ds"><input id="fb-ds" name="datasetId" required inputMode="numeric" className={inputClasses} /></Field>
                  <Field label="Conversions API access token" htmlFor="fb-tok" hint="Stored encrypted. Never shown again."><input id="fb-tok" name="accessToken" type="password" required autoComplete="off" className={inputClasses} /></Field>
                  <Field label="Test event code" htmlFor="fb-test" hint="From Events Manager → Test events. Needed for testing."><input id="fb-test" name="testEventCode" className={inputClasses} /></Field>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Google Ads customer ID" htmlFor="g-cid"><input id="g-cid" name="customerId" required placeholder="123-456-7890" className={inputClasses} /></Field>
                  <Field label="Manager account ID (optional)" htmlFor="g-mcc"><input id="g-mcc" name="loginCustomerId" className={inputClasses} /></Field>
                  <Field label="OAuth client ID" htmlFor="g-client"><input id="g-client" name="clientId" required className={inputClasses} /></Field>
                  <Field label="OAuth client secret" htmlFor="g-secret"><input id="g-secret" name="clientSecret" type="password" required autoComplete="off" className={inputClasses} /></Field>
                  <div className="sm:col-span-2"><Field label="Refresh token" htmlFor="g-refresh" hint="Stored encrypted. Never shown again."><input id="g-refresh" name="refreshToken" type="password" required autoComplete="off" className={inputClasses} /></Field></div>
                </div>
              )}
              <div><button disabled={pending} className={buttonClasses("primary")}>Connect</button></div>
              {demo && <p className="text-xs text-ink-subtle">Demo mode: nothing is sent to {d === "meta" ? "Meta" : "Google"}; any values work.</p>}
            </form>
            </Collapsible>
            </>
          ) : <p className="text-sm text-ink-muted">Not connected.</p>}
        </Step>

        <Step n={2} title="Choose which milestones to report" done={mapped}>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); act(() => saveMappingAction(d, mapping, wa)); }}>
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
              {FEEDBACK_MILESTONES.map((m) => (
                <li key={m} className="flex flex-wrap items-center gap-3 p-3">
                  <label className="flex min-w-48 flex-1 items-start gap-2.5 text-sm">
                    <input type="checkbox" disabled={!writable} checked={mapping[m].enabled} onChange={(e) => setMapping({ ...mapping, [m]: { ...mapping[m], enabled: e.target.checked } })} className="mt-0.5" />
                    <span>
                      <span className="font-medium">{FEEDBACK_MILESTONE_LABELS[m].title}</span>
                      <span className="block text-xs text-ink-subtle">{FEEDBACK_MILESTONE_LABELS[m].hint}</span>
                    </span>
                  </label>
                  {mapping[m].enabled && (
                    <div className="flex flex-wrap gap-2">
                      <input aria-label={`${FEEDBACK_MILESTONE_LABELS[m].title} event name`} disabled={!writable} value={mapping[m].eventName} onChange={(e) => setMapping({ ...mapping, [m]: { ...mapping[m], eventName: e.target.value } })} className={`${inputClasses} w-44`} />
                      {d === "google" && (
                        assets?.googleActions.length ? <select aria-label={`${FEEDBACK_MILESTONE_LABELS[m].title} conversion action`} disabled={!writable} value={mapping[m].conversionActionId} onChange={(e) => {
                          const action = assets.googleActions.find((a) => a.id === e.target.value);
                          setMapping({ ...mapping, [m]: { ...mapping[m], conversionActionId: e.target.value, conversionCustomerId: action?.ownerCustomerId ?? "" } });
                        }} className={`${inputClasses} w-56`}><option value="">Choose conversion action</option>{assets.googleActions.map((a) => <option key={`${a.ownerCustomerId}:${a.id}`} value={a.id}>{a.name}</option>)}</select> : <input aria-label={`${FEEDBACK_MILESTONE_LABELS[m].title} conversion action ID`} placeholder="Conversion action ID" disabled={!writable} value={mapping[m].conversionActionId} onChange={(e) => setMapping({ ...mapping, [m]: { ...mapping[m], conversionActionId: e.target.value } })} className={`${inputClasses} w-48`} />
                      )}
                      {d === "meta" && wa && <select aria-label={`${FEEDBACK_MILESTONE_LABELS[m].title} WhatsApp event`} disabled={!writable} value={mapping[m].whatsappEventName ?? "LeadSubmitted"} onChange={(e) => setMapping({ ...mapping, [m]: { ...mapping[m], whatsappEventName: e.target.value as "LeadSubmitted" | "ViewContent" } })} className={`${inputClasses} w-48`}><option value="LeadSubmitted">WhatsApp: Lead submitted</option><option value="ViewContent">WhatsApp: Content viewed</option></select>}
                      <span className="self-center text-xs text-ink-subtle">{accepted(m)} sent in 28 days</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {d === "meta" && (
              <label className="flex items-start gap-2.5 text-sm">
                <input type="checkbox" disabled={!writable} checked={wa} onChange={(e) => setWa(e.target.checked)} className="mt-0.5" />
                <span>Also report leads from click-to-WhatsApp ads <span className="block text-xs text-ink-subtle">Connect WhatsApp outcomes above and test with a real ad inquiry before going live.</span></span>
              </label>
            )}
            {badName && <p role="alert" className="text-sm text-critical">Event names can&rsquo;t mention services or health (&ldquo;{badName}&rdquo;). Use a funnel word like &ldquo;QualifiedLead&rdquo;.</p>}
            {writable && <div><button disabled={pending || Boolean(badName)} className={buttonClasses("secondary")}>Save milestones</button></div>}
          </form>
        </Step>

        <Step n={3} title="Confirm it's allowed" done={reviewed}>
          {dest.eligibility === "blocked_by_policy" ? (
            <p className="text-sm text-ink-muted">Marked as not allowed. Your milestones still count in the CRM; nothing is sent.</p>
          ) : reviewed ? (
            <p className="text-sm text-ink-muted">Confirmed {dest.checklistConfirmedAt ? relativeTime(dest.checklistConfirmedAt) : ""}.</p>
          ) : writable ? (
            <div className="flex flex-col gap-2 text-sm">
              {[
                `Our privacy or legal lead has approved sending these milestones to ${d === "meta" ? "Meta" : "Google"}.`,
                d === "meta"
                  ? "We checked Meta's policies for our business category and this dataset — health-related restrictions don't stop this."
                  : "We checked Google's health-in-personalized-advertising and customer-data policies for our services — offline conversions by click ID are allowed for this account.",
                "We understand only the milestone, its time and the platform's own ID are sent — no names, contact details, services or notes.",
              ].map((text, i) => (
                <label key={i} className="flex items-start gap-2.5">
                  <input type="checkbox" checked={checks[i]} onChange={(e) => setChecks(checks.map((c, j) => (j === i ? e.target.checked : c)))} className="mt-0.5" />
                  <span>{text}</span>
                </label>
              ))}
              <div className="mt-1 flex flex-wrap gap-2">
                <button type="button" disabled={pending || !checks.every(Boolean) || !mapped} onClick={() => act(() => confirmChecklistAction(d))} className={buttonClasses("primary", "sm")}>Confirm and allow testing</button>
                <button type="button" disabled={pending} onClick={() => { if (window.confirm("Mark as not allowed? Nothing will be sent to this platform.")) act(() => markBlockedAction(d)); }} className={buttonClasses("ghost", "sm")}>It isn&rsquo;t allowed for us</button>
              </div>
              {!mapped && <p className="text-xs text-ink-subtle">Choose and save at least one milestone first.</p>}
            </div>
          ) : <p className="text-sm text-ink-muted">Waiting for an admin.</p>}
        </Step>

        <Step n={4} title="Test, then go live" done={dest.eligibility === "approved_production"}>
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={pending || !mapped} onClick={() => start(async () => { const r = await previewFeedbackAction(d); if (r.ok) setPreview(r.preview); else setResult({ ok: false, message: r.message }); })} className={buttonClasses("secondary", "sm")}>Preview what&rsquo;s sent</button>
              {writable && reviewed && <button type="button" disabled={pending} onClick={() => act(() => testFeedbackAction(d, d === "google" ? "google" : dest.accountLabel ? "meta" : "whatsapp"))} className={buttonClasses("secondary", "sm")}>Send a test event</button>}
              {writable && dest.eligibility === "approved_test_only" && (
                <button type="button" disabled={pending || !testsPassed} onClick={() => { if (window.confirm(`Go live? Real milestones will be sent to ${d === "meta" ? "Meta" : "Google"} from now on. Old ones are not back-filled.`)) act(() => goLiveAction(d)); }} className={buttonClasses("primary", "sm")}>Go live</button>
              )}
            </div>
            {dest.lastTestAt && (
              <p className={testsPassed ? "text-positive" : "text-critical"}>
                Last test {relativeTime(dest.lastTestAt)}: {testsPassed ? "worked" : "needs attention"}{dest.lastTestDetail ? ` — ${dest.lastTestDetail}` : ""}
              </p>
            )}
            {dest.eligibility === "approved_test_only" && !testsPassed && <p className="text-ink-subtle">Go live unlocks after a successful test.</p>}
            {preview && (
              <div className="rounded-lg border border-line bg-surface-muted p-3">
                <p className="text-xs text-ink-muted">Based on {preview.basedOn} · mode: {preview.mode === "test" ? "test" : "live"}</p>
                <pre className="mt-2 overflow-x-auto text-xs">{JSON.stringify(preview.payload, null, 2)}</pre>
              </div>
            )}
          </div>
        </Step>

        {d === "meta" && dest.includeWhatsAppAds && writable && <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={pending || !dest.whatsappConnected} onClick={() => act(() => testFeedbackAction("meta", "whatsapp"))} className={buttonClasses("secondary")}>Test WhatsApp outcomes</button>
          <span className="text-sm text-ink-muted">{dest.whatsappTestOk ? "WhatsApp test passed" : "WhatsApp needs its own successful test"}</span>
        </div>}
        {dest.eligibility === "approved_production" && (
          <div className="rounded-lg border border-line bg-surface-muted p-4 text-sm">
            <p className="font-medium">Before your marketer changes bidding</p>
            <ul className="mt-2 list-disc pl-5 text-ink-muted">
              <li>Sending these events does <strong className="text-ink">not</strong> change your campaigns. Optimising for them is a separate choice in {d === "meta" ? "Ads Manager (Conversion Leads)" : "Google Ads (conversion goals)"}.</li>
              <li>Check the events arrive in {d === "meta" ? "Events Manager" : "Google Ads → Conversions"} with no errors first.</li>
              <li>Platforms learn best with steady volume — roughly 50 or more a week of the chosen milestone.</li>
              <li>Never upload patient lists as custom audiences.</li>
            </ul>
          </div>
        )}
        <Outcome result={result} />
      </div>
    </section>
  );
}

const STATE: Record<string, { tone: "positive" | "critical" | "caution" | "neutral" | "brand"; label: string }> = {
  accepted: { tone: "positive", label: "Accepted" },
  sent: { tone: "brand", label: "Google processing" },
  queued: { tone: "brand", label: "Waiting" },
  sending: { tone: "brand", label: "Sending" },
  blocked: { tone: "caution", label: "Blocked" },
  unmatched: { tone: "neutral", label: "Not from this ad" },
  canceled: { tone: "neutral", label: "Cancelled" },
  rejected: { tone: "critical", label: "Rejected" },
  candidate: { tone: "neutral", label: "Candidate" },
};

export function EventLog({ events, writable = false }: { events: FeedbackEventDto[]; writable?: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FbResult | null>(null);
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-base font-semibold">Recent events</h2>
      <Outcome result={result} />
      <p className="mt-0.5 text-sm text-ink-muted">Every milestone the CRM considered sending, and what happened. Your own funnel counts never depend on this.</p>
      {events.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">Nothing yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <Link href={`/leads/${e.leadId}`} className="font-medium hover:text-brand">{e.personName ?? "Lead"}</Link>
              <span className="text-ink-muted">{FEEDBACK_MILESTONE_LABELS[e.milestone].title} → {e.destination === "meta" ? "Meta" : "Google"}{e.testMode ? " (test)" : ""}</span>
              <span className="text-xs text-ink-subtle">{relativeTime(e.createdAt)}{e.attempts > 1 ? ` · ${e.attempts} tries` : ""}</span>
              <span className="ml-auto"><Badge tone={STATE[e.state]?.tone ?? "neutral"}>{STATE[e.state]?.label ?? e.state}</Badge></span>
              {writable && ["rejected", "blocked"].includes(e.state) && <button type="button" disabled={pending} onClick={() => start(async () => setResult(await retryFeedbackAction(e.id)))} className={buttonClasses("secondary", "sm")}>Retry</button>}
              {e.reason && <p className="w-full text-xs text-ink-subtle">{e.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
