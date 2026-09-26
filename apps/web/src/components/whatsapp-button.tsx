"use client";

import { useState, useTransition } from "react";
import { openConversationAction } from "@/lib/inbox-actions";
import { ChatIcon } from "./icons";
import { buttonClasses } from "./ui";

/** Opens (or starts) this person's WhatsApp thread in the inbox. */
export function WhatsAppButton({ personId }: { personId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => {
          const r = await openConversationAction(personId);
          if (r && !r.ok) setError(r.message);
        })}
        className={buttonClasses("secondary")}
      >
        <ChatIcon size={16} /> {pending ? "Opening…" : "WhatsApp"}
      </button>
      {error && <span role="alert" className="mt-1 max-w-56 text-xs text-critical">{error}</span>}
    </span>
  );
}
