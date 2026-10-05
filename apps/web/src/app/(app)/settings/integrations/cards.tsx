"use client";

import { useState, useTransition } from "react";
import type { ConnectionDto } from "@skincrm/contracts";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import { DigitsInput, EmailInput, PhoneInput } from "@/components/contact-inputs";
import { WhatsAppConnect } from "./whatsapp-connect";
import {
  checkConnectionAction,
  retryInboundAction,
  connectMetaAction,
  connectWhatsAppAction,
  createGoogleKeyAction,
  disconnectAction,
  saveMessagingAction,
  sendTestLeadAction,
  startOAuthAction,
  syncGoogleFormsAction,
  testSendAction,
  type Result,
} from "@/lib/integration-actions";

function Outcome({ result }: { result: Result | null }) {
  if (!result) return null;
  return result.ok ? (
    <p role="status" className="rounded-lg bg-positive-soft px-3 py-2 text-sm text-positive">{result.detail ?? "Saved."}</p>
  ) : (
    <div role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
      <p>{result.message}</p>
      {result.fieldErrors && Object.keys(result.fieldErrors).length > 0 && (
        <ul className="mt-1 list-disc pl-5">{Object.values(result.fieldErrors).flat().map((m) => <li key={m}>{m}</li>)}</ul>
      )}
    </div>
  );
}

function Status({ connection }: { connection: ConnectionDto | undefined }) {
  if (!connection) return <Badge>Not connected</Badge>;
  if (connection.status === "healthy") return <Badge tone="positive">Connected</Badge>;
  if (connection.status === "degraded" || connection.status === "error") return <Badge tone="critical">Needs attention</Badge>;
  return <Badge tone="caution">Connecting</Badge>;
}

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <div className="mt-1 flex gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm">{value}</code>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className={buttonClasses("secondary", "sm")}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function ConnectionFooter({ connection, testProvider, pending, run }: {
  connection: ConnectionDto;
  testProvider?: "meta" | "google";
  pending: boolean;
  run: (fn: () => Promise<Result>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
      <p className="mr-auto text-sm text-ink-muted">
        {connection.displayName}
        {connection.lastEventAt ? ` · last lead ${new Date(connection.lastEventAt).toLocaleString()}` : " · nothing received yet"}
      </p>
      <button type="button" disabled={pending} onClick={() => run(() => checkConnectionAction(connection.id))} className={buttonClasses("secondary", "sm")}>Check connection</button>
      {testProvider && (
        <button type="button" disabled={pending} onClick={() => run(() => sendTestLeadAction(testProvider))} className={buttonClasses("secondary", "sm")}>
          Send a test lead
        </button>
      )}
      <button type="button" disabled={pending} onClick={() => { if (window.confirm("Disconnect? New leads from this account will stop arriving.")) run(() => disconnectAction(connection.id)); }} className={buttonClasses("danger", "sm")}>
        Disconnect
      </button>
      {connection.lastError && <p className="w-full text-sm text-critical">Last problem: {connection.lastError}</p>}
    </div>
  );
}

function useRunner() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const run = (fn: () => Promise<Result>) => start(async () => setResult(await fn()));
  return { pending, result, run };
}

/** Sends the browser to Facebook / Google to sign in (or straight back, in demo mode). */
function ConnectButton({ provider, label, subtle = false, run, pending }: {
  provider: "meta" | "google";
  label: string;
  subtle?: boolean;
  pending: boolean;
  run: (fn: () => Promise<Result>) => void;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(async () => {
        const result = await startOAuthAction(provider);
        if (result.ok && result.url) window.location.assign(result.url);
        return result.ok ? { ok: true, detail: "Opening sign-in…" } : result;
      })}
      className={buttonClasses(subtle ? "secondary" : "primary", subtle ? "sm" : "md")}
    >
      {pending ? "Opening sign-in…" : label}
    </button>
  );
}

export function MetaCard({ connection, webhook, verifyToken, live }: { connection?: ConnectionDto; webhook: string; verifyToken: string; live: boolean }) {
  const { pending, result, run } = useRunner();
  return (
    <Section title="Facebook & Instagram lead ads" status={<Status connection={connection} />}
      intro="New leads from your Meta lead forms arrive in Leads within seconds, with the ad and campaign they came from.">
      {connection ? (
        <>
          <ConnectionFooter connection={connection} testProvider="meta" pending={pending} run={run} />
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-xs text-ink-subtle">
              {connection.connectedVia === "oauth" ? "Connected with Facebook." : "Connected with a pasted token."} Changed Page, or Facebook asked you to sign in again?
            </p>
            <ConnectButton provider="meta" label="Reconnect with Facebook" subtle pending={pending} run={run} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <Steps items={[
            "Press Connect with Facebook and sign in with the account that manages the clinic's Facebook Page.",
            "Allow SkinCRM to see the Page's leads, then choose the Page.",
            "That's it — Instagram lead ads come through the same Page.",
          ]} />
          <div><ConnectButton provider="meta" label="Connect with Facebook" pending={pending} run={run} /></div>
          {!live && <p className="text-xs text-ink-subtle">Demo mode: you won't leave SkinCRM; two made-up Pages are offered.</p>}
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Enter a Page ID and token by hand instead</summary>
            <form className="mt-3 flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => connectMetaAction(String(f.get("pageId")), String(f.get("token")))); }}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Page ID" htmlFor="meta-page"><DigitsInput id="meta-page" name="pageId" required minLength={5} maxLength={30} /></Field>
                <Field label="Page access token" htmlFor="meta-token" hint="Needs leads_retrieval and pages_manage_metadata. Stored encrypted; never shown again."><input id="meta-token" name="token" type="password" required autoComplete="off" className={inputClasses} /></Field>
              </div>
              <div><button disabled={pending} className={buttonClasses("secondary")}>{pending ? "Checking…" : "Connect"}</button></div>
            </form>
          </details>
        </div>
      )}
      <Advanced>
        <p className="text-sm text-ink-muted">For whoever runs the Meta app: the app's <strong>leadgen</strong> webhook must point here. Connect with Facebook subscribes each Page automatically.</p>
        <CopyField label="Callback URL" value={webhook} />
        <CopyField label="Verify token" value={verifyToken} />
      </Advanced>
      <Outcome result={result} />
    </Section>
  );
}

export function GoogleCard({ connection, webhook, live }: { connection?: ConnectionDto; webhook: string; live: boolean }) {
  const { pending, result, run } = useRunner();
  const key = result?.ok ? result.key : undefined;
  const viaOAuth = connection?.connectedVia === "oauth";

  const manual = (
    <div className="flex flex-col gap-4">
      <Steps items={[
        "Press Create key below and keep this page open.",
        "In Google Ads, open your lead form asset → Export leads → Webhook integration.",
        "Paste the Webhook URL and the Key, then press Send test data in Google.",
      ]} />
      <CopyField label="Webhook URL" value={webhook} />
      {key && (
        <div className="rounded-lg border border-caution/50 bg-caution-soft p-3">
          <CopyField label="Key — copy it now, it won't be shown again" value={key} />
        </div>
      )}
      <div>
        <button type="button" disabled={pending} onClick={() => { if (!connection || window.confirm("Create a new key? The old one stops working, so update Google Ads too.")) run(() => createGoogleKeyAction()); }} className={buttonClasses("secondary", "sm")}>
          {connection ? "Replace key" : "Create key"}
        </button>
      </div>
    </div>
  );

  return (
    <Section title="Google Ads lead forms" status={<Status connection={connection} />}
      intro="Leads from Google Ads lead-form assets arrive in Leads with the campaign and click id.">
      {connection ? (
        <>
          {viaOAuth && (
            <p className="text-sm">
              {connection.leadForms === 0 ? "No lead forms send to SkinCRM yet." : `${connection.leadForms} lead ${connection.leadForms === 1 ? "form sends" : "forms send"} leads to SkinCRM.`}{" "}
              <span className="text-ink-muted">Made a new form in Google Ads? Check for it so its leads come here too.</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {viaOAuth && <button type="button" disabled={pending} onClick={() => run(() => syncGoogleFormsAction())} className={buttonClasses("secondary", "sm")}>Check for new lead forms</button>}
            <ConnectButton provider="google" label={viaOAuth ? "Reconnect with Google" : "Switch to Connect with Google"} subtle pending={pending} run={run} />
          </div>
          <ConnectionFooter connection={{ ...connection, displayName: `${connection.displayName ?? "Google Ads"}${connection.accountLabel ? ` (${connection.accountLabel})` : ""}` }} testProvider="google" pending={pending} run={run} />
          {!viaOAuth && <Advanced>{manual}</Advanced>}
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <Steps items={[
            "Press Connect with Google Ads and sign in with the Google account that manages the clinic's ads.",
            "Choose the ad account.",
            "SkinCRM adds itself to every lead form in that account — no copying keys.",
          ]} />
          <div><ConnectButton provider="google" label="Connect with Google Ads" pending={pending} run={run} /></div>
          {!live && <p className="text-xs text-ink-subtle">Demo mode: you won't leave SkinCRM; a made-up account with two lead forms is offered.</p>}
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Set up a webhook key by hand instead</summary>
            <div className="mt-3">{manual}</div>
          </details>
        </div>
      )}
      {result && !key && <Outcome result={result} />}
    </Section>
  );
}

export function WhatsAppCard({ connection, webhook, verifyToken, live }: { connection?: ConnectionDto; webhook: string; verifyToken: string; live: boolean }) {
  const { pending, result, run } = useRunner();
  return (
    <Section title="WhatsApp Business" status={<Status connection={connection} />}
      intro="Patients' WhatsApp messages land in the Inbox, and replies and reminders go out from your business number.">
      {connection ? (
        <>
          <ConnectionFooter connection={connection} pending={pending} run={run} />
          <p className="text-xs text-ink-subtle">
            {connection.connectedVia === "oauth" ? "Connected with Meta's WhatsApp sign-up." : "Connected with a pasted token."} To switch numbers, disconnect and connect again.
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-4">
        <Steps items={[
          "Choose which number below, then press Connect WhatsApp.",
          "In Meta's window, sign in with the Facebook account that manages the clinic's business and follow the steps (confirm the number with the code Meta sends).",
          "That's it — patients' messages start arriving in the Inbox.",
        ]} />
        <WhatsAppConnect onResult={(r) => run(async () => r)} />
        {!live && <p className="text-xs text-ink-subtle">Demo mode: no Meta window; a made-up number connects, and the built-in test phone plays the patient (&ldquo;Test message&rdquo; in the Inbox).</p>}
        <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">Enter a phone number ID and token by hand instead</summary>
        <form className="mt-3 flex flex-col gap-4" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          run(() => connectWhatsAppAction({ phoneNumberId: String(f.get("pn")), accessToken: String(f.get("token")), displayPhone: String(f.get("display") || "") || undefined, businessAccountId: String(f.get("waba") || "") || undefined }));
        }}>
          <Steps items={[
            "In Meta's WhatsApp Manager, add your business number to the WhatsApp Cloud API.",
            "Copy the Phone number ID and create a permanent access token for it.",
            "Paste them below and press Connect.",
          ]} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone number ID" htmlFor="wa-pn"><DigitsInput id="wa-pn" name="pn" required minLength={5} maxLength={30} /></Field>
            <Field label="Your WhatsApp number" htmlFor="wa-display" hint="As patients see it."><PhoneInput id="wa-display" name="display" autoComplete="off" placeholder="+1 305 555 0100" /></Field>
            <Field label="Access token" htmlFor="wa-token" hint="Stored encrypted. Never shown again."><input id="wa-token" name="token" type="password" required autoComplete="off" className={inputClasses} /></Field>
            <Field label="Business account ID (optional)" htmlFor="wa-waba"><DigitsInput id="wa-waba" name="waba" minLength={5} maxLength={30} /></Field>
          </div>
          <div><button disabled={pending} className={buttonClasses("secondary")}>{pending ? "Checking…" : "Connect"}</button></div>
        </form>
        </details>
        </div>
      )}
      <Advanced>
        <p className="text-sm text-ink-muted">For whoever sets up the Meta app: subscribe the WhatsApp account to the <strong>messages</strong> field with these details.</p>
        <CopyField label="Callback URL" value={webhook} />
        <CopyField label="Verify token" value={verifyToken} />
      </Advanced>
      <Outcome result={result} />
    </Section>
  );
}

export function SendingCard({ sending, modes, email }: {
  sending: { enabled: boolean; promotionalApproved: boolean; postalAddress: string | null; sendingDomain: string | null; supportEmail: string | null; emailFrom: string };
  modes: { email: string; whatsapp: string };
  email: { provider: "mock" | "smtp" | "postmark"; inboundAddress: string | null; eventsWebhook: string; inboundWebhook: string };
}) {
  const { pending, result, run } = useRunner();
  const test = useRunner();
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");
  return (
    <Section title="Sending" status={sending.enabled ? <Badge tone="positive">On</Badge> : <Badge tone="critical">Off</Badge>}
      intro={sending.enabled
        ? "Messages to patients are being sent. Every one is still checked for consent, opt-outs and quiet hours first."
        : "Sending is switched off for this installation, so nothing goes to patients. Your technical contact turns it on (OUTBOUND_SENDING_ENABLED)."}>
      <form className="flex flex-col gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(() => saveMessagingAction({
          promotionalSendingApproved: f.get("promo") === "on",
          postalAddress: String(f.get("address") ?? ""),
          sendingDomain: String(f.get("domain") ?? ""),
          supportEmail: String(f.get("support") ?? ""),
        }));
      }}>
        <Field label="Clinic postal address" htmlFor="addr" hint="Printed at the bottom of marketing email, as the law requires.">
          <input id="addr" name="address" maxLength={300} autoComplete="street-address" defaultValue={sending.postalAddress ?? ""} className={inputClasses} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email sending domain" htmlFor="domain" hint={`Emails come from noreply@ this domain (now ${sending.emailFrom}).`}>
            <input id="domain" name="domain" inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={200} pattern="[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+" title="Just the domain, like yourclinic.com" defaultValue={sending.sendingDomain ?? ""} placeholder="yourclinic.com" className={inputClasses} />
          </Field>
          <Field label="Reply-to / contact email" htmlFor="support">
            <EmailInput id="support" name="support" defaultValue={sending.supportEmail} placeholder="frontdesk@yourclinic.com" />
          </Field>
        </div>
        <label className="flex items-start gap-3 rounded-lg border border-line p-3">
          <input type="checkbox" name="promo" defaultChecked={sending.promotionalApproved} className="mt-1" />
          <span>
            <span className="block text-sm font-medium">Marketing messages are approved</span>
            <span className="block text-xs text-ink-muted">Tick once your clinic has signed off marketing copy and who receives it. Even then, marketing only goes to patients who agreed to it.</span>
          </span>
        </label>
        <div><button disabled={pending} className={buttonClasses("primary")}>{pending ? "Saving…" : "Save"}</button></div>
        <Outcome result={result} />
      </form>

      <div className="flex flex-col gap-2 border-t border-line pt-4 text-sm">
        <p className="font-medium">Email provider: {email.provider === "postmark" ? "Postmark" : email.provider === "smtp" ? "SMTP relay" : "Demo (nothing leaves this machine)"}</p>
        {email.provider === "postmark" ? (
          <>
            <p className="text-ink-muted">
              Patients&rsquo; replies come back into the Inbox{email.inboundAddress ? "" : " once POSTMARK_INBOUND_ADDRESS is set"}; bounces, spam complaints and unsubscribes stop further email automatically.
            </p>
            <Advanced>
              <p className="text-sm text-ink-muted">In Postmark: Servers → your server → Webhooks (Delivery, Bounce, Spam complaint, Subscription change) and Inbound. Put the webhook user and password from the server settings into the URLs as <code>https://user:password@…</code>.</p>
              <CopyField label="Events webhook" value={email.eventsWebhook} />
              <CopyField label="Inbound webhook" value={email.inboundWebhook} />
              {email.inboundAddress && <CopyField label="Inbound address (replies go here)" value={email.inboundAddress} />}
            </Advanced>
          </>
        ) : email.provider === "smtp" ? (
          <p className="text-ink-muted">Sends through your SMTP relay. Replies and bounces aren&rsquo;t tracked — switch to Postmark (EMAIL_PROVIDER=postmark) to get them in SkinCRM.</p>
        ) : null}
      </div>

      <form className="flex flex-col gap-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); const to = String(new FormData(e.currentTarget).get("to")); test.run(() => testSendAction(channel, to)); }}>
        <p className="text-sm font-medium">Send yourself a test</p>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as "email" | "whatsapp")} className="min-h-10 rounded-lg border border-line-strong bg-surface px-2 text-sm">
            <option value="email">Email{modes.email === "mock" ? " (demo)" : ""}</option>
            <option value="whatsapp">WhatsApp{modes.whatsapp === "mock" ? " (demo)" : ""}</option>
          </select>
          <label className="sr-only" htmlFor="test-to">Send to</label>
          <div className="min-w-0 flex-1">
            {channel === "email"
              ? <EmailInput key="email" id="test-to" name="to" required placeholder="you@clinic.com" />
              : <PhoneInput key="phone" id="test-to" name="to" required autoComplete="off" placeholder="+1 305 555 0100" />}
          </div>
          <button disabled={test.pending || !sending.enabled} className={buttonClasses("secondary")}>{test.pending ? "Sending…" : "Send test"}</button>
        </div>
        <Outcome result={test.result} />
      </form>
    </Section>
  );
}

function Section({ title, status, intro, children }: { title: string; status: React.ReactNode; intro: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 max-w-2xl text-sm text-ink-muted">{intro}</p>
        </div>
        {status}
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">{i + 1}</span>
          <span className="pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Advanced({ children }: { children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">Technical details</summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}

export function RetryInboundButton({ id }: { id: string }) {
  const { pending, result, run } = useRunner();
  return <div><button type="button" disabled={pending} onClick={() => run(() => retryInboundAction(id))} className={buttonClasses("secondary", "sm")}>Retry</button><Outcome result={result} /></div>;
}
