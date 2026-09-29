"use client";

import { useEffect } from "react";
import { buttonClasses } from "./ui";

/**
 * What staff see when a page cannot load — most often because the API is
 * restarting. Plain words and one action, instead of a stack trace.
 */
export function ErrorScreen({ error }: { error: Error & { digest?: string }; reset?: () => void }) {
  // A full reload, not reset(): when the shared layout itself failed (the
  // session lookup), only a fresh request re-runs it.
  const retry = () => window.location.reload();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">This page couldn’t load</h1>
      <p className="text-sm text-ink-muted">
        SkinCRM’s server didn’t respond. It may be restarting — wait a few seconds and try again. Nothing you saved has been lost.
      </p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={retry} className={buttonClasses()}>Try again</button>
        <a href="/home" className={buttonClasses("secondary")}>Go to Home</a>
      </div>
      {error.digest && <p className="mt-4 text-xs text-ink-subtle">Reference: {error.digest}</p>}
    </div>
  );
}
