"use client";

import { useState, useTransition } from "react";
import { Badge, buttonClasses } from "@/components/ui";
import { disconnectCalendarAction, startCalendarSyncAction, syncCalendarNowAction, type CalendarSyncResult } from "@/lib/calendar-sync-actions";

export interface CalendarSyncState {
  connection: { provider: "google" | "microsoft"; accountEmail: string | null; status: "healthy" | "error"; lastError: string | null; lastSyncedAt: string | null } | null;
  demo: boolean;
}

const NAMES = { google: "Google Calendar", microsoft: "Outlook / Microsoft 365" } as const;

/**
 * My profile → Calendar (D-94): connect your own Google or Outlook calendar.
 * Your SkinCRM appointments appear there; your other events block those times
 * in SkinCRM (only the times are read, never titles).
 */
export function CalendarSyncCard({ state, banner }: { state: CalendarSyncState; banner: { ok: boolean; text: string } | null }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<CalendarSyncResult | null>(null);
  const c = state.connection;
  const connect = (provider: "google" | "microsoft") => start(async () => {
    const r = await startCalendarSyncAction(provider);
    if (r.ok && r.url) window.location.assign(r.url);
    else setResult(r);
  });

  return (
    <section id="calendar" className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Calendar sync</h2>
          <p className="mt-1 text-sm text-ink-muted">Your SkinCRM appointments appear in your own calendar, and your other events stop patients and colleagues booking you at those times. Only the times of your events are read — never their titles.</p>
        </div>
        {c ? (c.status === "healthy" ? <Badge tone="positive">Connected</Badge> : <Badge tone="critical">Needs attention</Badge>) : <Badge>Not connected</Badge>}
      </header>
      {banner && <p role={banner.ok ? "status" : "alert"} className={`mb-3 rounded-lg px-3 py-2 text-sm ${banner.ok ? "bg-positive-soft text-positive" : "bg-critical-soft text-critical"}`}>{banner.text}</p>}
      {c ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {NAMES[c.provider]}{c.accountEmail ? ` · ${c.accountEmail}` : ""}
            <span className="text-ink-muted"> · {c.lastSyncedAt ? `last synced ${new Date(c.lastSyncedAt).toLocaleString()}` : "not synced yet"}</span>
          </p>
          {c.lastError && <p className="text-sm text-critical">Last problem: {c.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={() => start(async () => setResult(await syncCalendarNowAction()))} className={buttonClasses("secondary", "sm")}>Sync now</button>
            <button type="button" disabled={pending} onClick={() => connect(c.provider)} className={buttonClasses("secondary", "sm")}>Reconnect</button>
            <button type="button" disabled={pending} onClick={() => { if (window.confirm("Disconnect? SkinCRM removes the appointments it added to your calendar.")) start(async () => setResult(await disconnectCalendarAction())); }} className={buttonClasses("danger", "sm")}>Disconnect</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => connect("google")} className={buttonClasses()}>Connect Google Calendar</button>
          <button type="button" disabled={pending} onClick={() => connect("microsoft")} className={buttonClasses("secondary")}>Connect Outlook</button>
        </div>
      )}
      {state.demo && <p className="mt-3 text-xs text-ink-subtle">Demo mode: no sign-in; a pretend calendar is connected.</p>}
      {result && <p role={result.ok ? "status" : "alert"} className={`mt-3 text-sm ${result.ok ? "text-positive" : "text-critical"}`}>{result.ok ? (result.detail ?? "Done.") : result.message}</p>}
    </section>
  );
}
