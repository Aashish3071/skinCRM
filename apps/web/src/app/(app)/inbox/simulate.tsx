"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { buttonClasses, inputClasses } from "@/components/ui";
import { NameInput, PhoneInput } from "@/components/contact-inputs";
import { simulateInboundAction } from "@/lib/inbox-actions";

/**
 * Development and demo only (mock WhatsApp connector): pretend a patient sent
 * a message, so the inbox can be tried before a real number is connected.
 */
export function SimulateButton() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button type="button" onClick={() => ref.current?.showModal()}
        className="h-8 rounded-full px-3 text-[13px] font-medium text-[var(--wa-green)] hover:bg-black/5">
        + Test message
      </button>
      <dialog ref={ref} className="m-auto w-[min(420px,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-[var(--shadow-pop)] backdrop:bg-black/30">
        <form
          className="flex flex-col gap-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            startTransition(async () => {
              const r = await simulateInboundAction({ phone: String(f.get("phone")), name: String(f.get("name") || "") || undefined, body: String(f.get("body")) });
              if (!r.ok) return setError(r.message);
              ref.current?.close();
              router.push(`/inbox/${r.conversationId}`);
            });
          }}
        >
          <h2 className="text-base font-semibold">Pretend a patient wrote in</h2>
          <p className="text-sm text-ink-muted">For trying the inbox before WhatsApp is connected. Nothing is sent anywhere.</p>
          <div><label htmlFor="sim-phone" className="text-sm font-medium">Their phone number</label><PhoneInput id="sim-phone" name="phone" required autoComplete="off" placeholder="+1 305 555 0142" className={`${inputClasses} mt-1`} /></div>
          <div><label htmlFor="sim-name" className="text-sm font-medium">Their name (optional)</label><NameInput id="sim-name" name="name" autoComplete="off" className={`${inputClasses} mt-1`} /></div>
          <label className="text-sm font-medium">Message<textarea name="body" required rows={3} defaultValue="Hi! Do you have any openings next week?" className={`${inputClasses} mt-1`} /></label>
          {error && <p role="alert" className="text-sm text-critical">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => ref.current?.close()} className={buttonClasses("ghost")}>Cancel</button>
            <button disabled={pending} className={buttonClasses("primary")}>{pending ? "Sending…" : "Receive it"}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
