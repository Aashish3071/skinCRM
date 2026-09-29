"use client";

import { useRef, useState, useTransition } from "react";
import { buttonClasses } from "@/components/ui";
import { completeWhatsAppSignupAction, startWhatsAppSignupAction, type Result } from "@/lib/integration-actions";

/**
 * "Connect WhatsApp" — Meta's Embedded Signup (D-88).
 *
 * Live: loads Facebook's SDK, opens Meta's popup, and collects two things it
 * sends back — a one-time code (FB.login callback) and the chosen WhatsApp
 * Business Account + phone-number ids (a postMessage from facebook.com). The
 * API does the rest. Demo: skips the popup and connects a made-up number the
 * built-in test phone answers.
 */
type FB = {
  init: (options: { appId: string; version: string; xfbml: boolean; autoLogAppEvents?: boolean }) => void;
  login: (callback: (response: { authResponse?: { code?: string } | null }) => void, options: Record<string, unknown>) => void;
};
declare global {
  interface Window { FB?: FB; fbAsyncInit?: () => void }
}

function loadFacebookSdk(appId: string, version: string): Promise<FB> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, version, xfbml: false, autoLogAppEvents: true });
      resolve(window.FB!);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Couldn't load Facebook's sign-up window. Check your connection or ad blocker and try again."));
    document.body.appendChild(script);
  });
}

export function WhatsAppConnect({ onResult }: { onResult: (result: Result) => void }) {
  const [coexistence, setCoexistence] = useState(true);
  const [pending, start] = useTransition();
  const [waiting, setWaiting] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);

  const connect = () => start(async () => {
    const begun = await startWhatsAppSignupAction();
    if (!begun.ok) return onResult(begun);
    const s = begun.start;

    if (s.mode === "mock") {
      onResult(await completeWhatsAppSignupAction({ state: s.state, code: "mock-wa-code", phoneNumberId: "100000000000001", wabaId: "200000000000001", coexistence }));
      return;
    }
    if (!s.appId || !s.configId) {
      onResult({ ok: false, message: "WhatsApp sign-up isn't configured on the server (META_APP_ID / META_WA_CONFIG_ID)." });
      return;
    }

    let fb: FB;
    try {
      fb = await loadFacebookSdk(s.appId, s.graphVersion);
    } catch (error) {
      onResult({ ok: false, message: error instanceof Error ? error.message : "Couldn't open Facebook." });
      return;
    }

    // The two halves arrive separately and in either order.
    let session: { phoneNumberId: string; wabaId: string } | null = null;
    let code: string | null = null;
    let finished = false;
    const stop = (result?: Result) => {
      finished = true;
      cleanup.current?.();
      setWaiting(false);
      if (result) onResult(result);
    };
    const finish = () => {
      if (finished || !session || !code) return;
      const ids = session;
      const oneTimeCode = code;
      stop();
      start(async () => onResult(await completeWhatsAppSignupAction({ state: s.state, code: oneTimeCode, ...ids, coexistence })));
    };
    const onMessage = (event: MessageEvent) => {
      // Only trust messages from Facebook itself.
      if (!/^https:\/\/([a-z0-9-]+\.)?facebook\.com$/.test(event.origin)) return;
      let data: { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string; current_step?: string } };
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (String(data.event).startsWith("FINISH")) {
        session = { phoneNumberId: String(data.data?.phone_number_id ?? ""), wabaId: String(data.data?.waba_id ?? "") };
        finish();
      } else if (data.event === "CANCEL") {
        stop({ ok: false, message: data.data?.current_step ? `Sign-up stopped at "${data.data.current_step}". Nothing was connected.` : "You closed the WhatsApp sign-up, so nothing was connected." });
      }
    };
    window.addEventListener("message", onMessage);
    cleanup.current = () => window.removeEventListener("message", onMessage);
    setWaiting(true);

    fb.login((response) => {
      code = response.authResponse?.code ?? null;
      if (!code) {
        stop({ ok: false, message: "You closed the WhatsApp sign-up, so nothing was connected." });
        return;
      }
      finish();
    }, {
      config_id: s.configId,
      response_type: "code",
      override_default_response_type: true,
      extras: {
        setup: {},
        sessionInfoVersion: "3",
        ...(coexistence ? { featureType: "whatsapp_business_app_onboarding" } : {}),
      },
    });
  });

  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="text-sm font-medium">Which number?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {[
            { value: true, title: "The number we already use", text: "Keep using the WhatsApp Business app on the phone. Messages show up in both." },
            { value: false, title: "A new number for SkinCRM", text: "A number not yet on WhatsApp. Replies are sent only from SkinCRM." },
          ].map((option) => (
            <label key={String(option.value)} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${coexistence === option.value ? "border-brand bg-brand-soft" : "border-line-strong hover:bg-surface-muted"}`}>
              <input type="radio" name="wa-kind" checked={coexistence === option.value} onChange={() => setCoexistence(option.value)} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">{option.title}</span>
                <span className="block text-xs text-ink-muted">{option.text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending || waiting} onClick={connect} className={buttonClasses()}>
          {waiting ? "Finish in the Facebook window…" : pending ? "Connecting…" : "Connect WhatsApp"}
        </button>
        {waiting && <button type="button" onClick={() => { cleanup.current?.(); setWaiting(false); }} className={buttonClasses("ghost", "sm")}>Cancel</button>}
      </div>
    </div>
  );
}
