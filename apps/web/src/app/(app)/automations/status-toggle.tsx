"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import type { AutomationStatus } from "@skincrm/contracts";
import { setAutomationStatusAction } from "@/lib/automation-actions";

/** On/off switch for the list. A real switch role, so it reads as one. */
export function StatusToggle({ id, status }: { id: string; status: AutomationStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useOptimistic(status);
  const on = current === "active";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? "Automation is on" : "Automation is off"}
        disabled={pending}
        onClick={() => {
          if (on && !window.confirm("Turn this off? Anyone currently in it will be stopped.")) return;
          setError(null);
          startTransition(async () => {
            setCurrent(on ? "paused" : "active");
            const result = await setAutomationStatusAction(id, on ? "paused" : "active");
            if (result.status === "error") setError(result.message);
            router.refresh();
          });
        }}
        className="flex items-center gap-2 text-sm"
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? "bg-brand" : "bg-line-strong"}`}
        >
          <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
        </span>
        <span className={on ? "font-medium" : "text-ink-muted"}>{on ? "On" : "Off"}</span>
      </button>
      {error && (
        <p role="alert" className="max-w-56 text-right text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
