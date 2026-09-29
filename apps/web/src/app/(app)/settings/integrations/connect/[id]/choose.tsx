"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OAuthChoice } from "@skincrm/contracts";
import { buttonClasses } from "@/components/ui";
import { completeOAuthAction } from "@/lib/integration-actions";

/** One radio per Page / ad account; the first one that can be used is preselected. */
export function ChooseAccount({ pendingId, provider, noun, choices }: { pendingId: string; provider: "meta" | "google"; noun: string; choices: OAuthChoice[] }) {
  const router = useRouter();
  const [choice, setChoice] = useState(choices.find((c) => !c.unavailableReason)?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => start(async () => {
    setError(null);
    const result = await completeOAuthAction(pendingId, choice);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(`/settings/integrations?${new URLSearchParams({ connected: provider, detail: result.detail ?? "" })}`);
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Which {noun} belongs to this clinic?</legend>
        <ul className="flex flex-col gap-2">
          {choices.map((c) => (
            <li key={c.id}>
              <label className={`flex min-h-12 items-start gap-3 rounded-lg border p-3 ${c.unavailableReason ? "cursor-not-allowed border-line opacity-60" : choice === c.id ? "cursor-pointer border-brand bg-brand-soft" : "cursor-pointer border-line-strong hover:bg-surface-muted"}`}>
                <input type="radio" name="choice" value={c.id} checked={choice === c.id} disabled={Boolean(c.unavailableReason)} onChange={() => setChoice(c.id)} className="mt-1" />
                <span className="min-w-0">
                  <span className="block font-medium">{c.label}</span>
                  {c.detail && <span className="block text-xs text-ink-muted">{c.detail}</span>}
                  {c.unavailableReason && <span className="mt-1 block text-xs text-critical">{c.unavailableReason}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {error && <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || !choice} className={buttonClasses()}>{pending ? "Connecting…" : `Connect this ${noun}`}</button>
      </div>
    </form>
  );
}
