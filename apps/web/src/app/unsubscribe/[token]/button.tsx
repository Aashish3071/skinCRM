"use client";

import { useState, useTransition } from "react";
import { buttonClasses } from "@/components/ui";
import { unsubscribeAction } from "./actions";

export function UnsubscribeButton({
  token,
  clinicName,
  channel,
  already,
}: {
  token: string;
  clinicName: string;
  channel: string;
  already: boolean;
}) {
  const [done, setDone] = useState(already);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const where = channel === "whatsapp" ? "WhatsApp" : "email";

  if (done) {
    return (
      <div role="status">
        <h1 className="text-xl font-semibold">You&rsquo;re unsubscribed</h1>
        <p className="mt-2 text-sm text-ink-muted">
          {clinicName} won&rsquo;t send you marketing by {where} any more. You&rsquo;ll still get messages about
          appointments you book.
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Stop marketing messages?</h1>
      <p className="mt-2 text-sm text-ink-muted">
        You&rsquo;ll stop receiving offers and news from {clinicName} by {where}. Appointment confirmations and reminders
        still arrive.
      </p>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-critical">
          Something went wrong. Please try again.
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const ok = await unsubscribeAction(token);
            setFailed(!ok);
            if (ok) setDone(true);
          })
        }
        className={`${buttonClasses("primary")} mt-5 w-full`}
      >
        {pending ? "Unsubscribing…" : "Unsubscribe"}
      </button>
    </>
  );
}
