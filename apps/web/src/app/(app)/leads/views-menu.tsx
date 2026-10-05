"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SavedViewDto } from "@skincrm/contracts";
import { buttonClasses, inputClasses } from "@/components/ui";
import { deleteViewAction, saveViewAction } from "@/lib/view-actions";

const sameQuery = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/**
 * Saved views: pick one to open it, save the current filters under a name
 * (admins can share it with everyone), or delete your own. A disclosure
 * popover — Escape and clicking outside close it.
 */
export function ViewsMenu({ views, current, isAdmin }: { views: SavedViewDto[]; current: Record<string, string>; isAdmin: boolean }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const active = views.find((v) => sameQuery(v.query, current));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const openView = (view: SavedViewDto) => {
    setOpen(false);
    router.push(`/leads?${new URLSearchParams(view.query)}`);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => { setOpen((v) => !v); setSaving(false); setError(null); }}
        className={buttonClasses("secondary", "sm")}
      >
        {active ? `View: ${active.name}` : "Views"} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={`${id}-panel`} className="absolute left-0 z-20 mt-2 w-72 rounded-card border border-line bg-surface p-2 shadow-[var(--shadow-pop)]">
          {views.length === 0 ? (
            <p className="px-2 py-2 text-sm text-ink-muted">No saved views yet. Filter the leads, then save the view here.</p>
          ) : (
            <ul className="flex max-h-64 flex-col overflow-y-auto">
              {views.map((v) => (
                <li key={v.id} className="flex items-center gap-1">
                  <button type="button" onClick={() => openView(v)} aria-current={active?.id === v.id ? "true" : undefined}
                    className={`min-h-9 min-w-0 flex-1 truncate rounded-md px-2 text-left text-sm hover:bg-surface-muted ${active?.id === v.id ? "font-medium text-brand" : ""}`}>
                    {v.name}
                    {v.shared && <span className="ml-1.5 text-xs text-ink-subtle">· shared{v.isMine ? "" : v.ownerName ? ` by ${v.ownerName}` : ""}</span>}
                  </button>
                  {(v.isMine || isAdmin) && (
                    <button type="button" aria-label={`Delete view ${v.name}`} disabled={pending}
                      onClick={() => { if (window.confirm(`Delete the view "${v.name}"?`)) start(async () => { const r = await deleteViewAction(v.id); if (!r.ok) setError(r.message); router.refresh(); }); }}
                      className="min-h-9 rounded-md px-2 text-sm text-ink-subtle hover:bg-critical-soft hover:text-critical">×</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 border-t border-line pt-2">
            {saving ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  start(async () => {
                    const r = await saveViewAction({ name: String(f.get("name") ?? "").trim(), query: current, shared: f.get("shared") === "on" });
                    if (!r.ok) return setError(r.message);
                    setSaving(false);
                    setOpen(false);
                    router.refresh();
                  });
                }}
                className="flex flex-col gap-2 px-1"
              >
                <label htmlFor={`${id}-name`} className="text-sm font-medium">Name this view</label>
                <input id={`${id}-name`} name="name" required maxLength={60} autoFocus placeholder="e.g. Unassigned Facebook leads" className={inputClasses} />
                {isAdmin && (
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="shared" /> Share with everyone at the clinic</label>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setSaving(false)} className={buttonClasses("ghost", "sm")}>Cancel</button>
                  <button disabled={pending} className={buttonClasses("primary", "sm")}>{pending ? "Saving…" : "Save view"}</button>
                </div>
              </form>
            ) : (
              <button type="button" disabled={Boolean(active)} onClick={() => setSaving(true)}
                className="min-h-9 w-full rounded-md px-2 text-left text-sm font-medium text-brand hover:bg-brand-soft disabled:text-ink-subtle disabled:hover:bg-transparent">
                {active ? "This view is saved" : "+ Save current filters as a view"}
              </button>
            )}
            {error && <p role="alert" className="mt-1 px-2 text-xs text-critical">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
