"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { LEAD_SOURCE_LABELS, STAGE_HINTS, type LeadDto, type StageCategory } from "@skincrm/contracts";

/** A little colour per channel so WhatsApp and ad leads stand out at a glance. */
const SOURCE_TONE: Partial<Record<LeadDto["source"], string>> = {
  whatsapp_organic: "bg-positive-soft text-positive",
  whatsapp_ad: "bg-positive-soft text-positive",
  meta_lead_ad: "bg-brand-soft text-brand",
  google_lead_form: "bg-caution-soft text-caution",
};
import { moveLeadAction } from "@/lib/crm-actions";
import { SlaBadge } from "@/components/sla-badge";
import { buttonClasses, inputClasses } from "@/components/ui";
import { relativeTime } from "@/lib/format";

export interface BoardStage {
  id: string;
  name: string;
  category: string;
  isClosed: boolean;
  requiresReason: boolean;
  position: number;
}

/** Leads only move forward through open stages (D-69); Won/Lost are always allowed. */
export function canMoveTo(lead: { furthestPosition: number | null }, stage: BoardStage): boolean {
  return stage.isClosed || lead.furthestPosition === null || stage.position >= lead.furthestPosition;
}

const LOSS_REASONS = ["Not interested", "Went to another clinic", "Price", "Never replied", "Not a fit"];

/**
 * The pipeline board. Drag a card to another column to move it.
 *
 * Dragging is never the only way (WCAG 2.5.7): every card also has a plain
 * "Move to" menu, which is what keyboard, screen-reader and touch users get.
 * Moves are optimistic — the card jumps at once and snaps back with a message
 * if the server refuses.
 */
export function LeadBoard({
  stages,
  leads,
  counts,
  canMove,
}: {
  stages: BoardStage[];
  leads: LeadDto[];
  counts: Record<string, number>;
  canMove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ lead: LeadDto; stage: BoardStage } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [items, moveOptimistic] = useOptimistic(leads, (state, move: { leadId: string; stageId: string }) =>
    state.map((lead) => (lead.id === move.leadId ? { ...lead, stageId: move.stageId } : lead)),
  );

  const move = (lead: LeadDto, stage: BoardStage, reason?: string) => {
    if (lead.stageId === stage.id) return;
    if (!canMoveTo(lead, stage)) {
      setError(`${lead.personName} has already reached a later stage — leads only move forward.`);
      return;
    }
    if (stage.requiresReason && !reason) {
      setAsking({ lead, stage });
      dialogRef.current?.showModal();
      return;
    }
    setError(null);
    startTransition(async () => {
      moveOptimistic({ leadId: lead.id, stageId: stage.id });
      const result = await moveLeadAction(lead.id, stage.id, reason);
      if (result.status === "error") setError(result.message);
      router.refresh();
    });
  };

  const byStage = new Map<string, LeadDto[]>();
  for (const lead of items) {
    const bucket = byStage.get(lead.stageId) ?? [];
    bucket.push(lead);
    byStage.set(lead.stageId, bucket);
  }

  return (
    <>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0" aria-busy={pending}>
        <div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-3 xl:auto-cols-[minmax(0,1fr)]">
          {stages.map((stage) => {
            const cards = byStage.get(stage.id) ?? [];
            const total = counts[stage.id] ?? cards.length;
            return (
              <section
                key={stage.id}
                aria-label={`${stage.name}, ${total} ${total === 1 ? "lead" : "leads"}`}
                onDragOver={(e) => {
                  if (!canMove) return;
                  e.preventDefault();
                  setDragOver(stage.id);
                }}
                onDragLeave={() => setDragOver((current) => (current === stage.id ? null : current))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const lead = items.find((l) => l.id === e.dataTransfer.getData("text/lead-id"));
                  if (lead) move(lead, stage);
                }}
                className={`flex min-h-64 flex-col rounded-card p-2 transition-colors ${
                  dragOver === stage.id ? "bg-brand-soft ring-2 ring-brand" : "bg-surface-muted"
                }`}
              >
                <header className="px-2 pb-2 pt-1">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold">{stage.name}</h2>
                    <span className="rounded-full bg-surface px-2 text-xs tabular-nums text-ink-muted">{total}</span>
                  </div>
                  {STAGE_HINTS[stage.category as StageCategory] && (
                    <p className="text-xs text-ink-subtle">{STAGE_HINTS[stage.category as StageCategory]}</p>
                  )}
                </header>
                <ul className="flex flex-col gap-2">
                  {cards.map((lead) => (
                    <li
                      key={lead.id}
                      draggable={canMove}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/lead-id", lead.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      className="rounded-lg border border-line bg-surface p-3 shadow-[var(--shadow-card)] hover:border-line-strong"
                    >
                      <Link href={`/leads/${lead.id}`} className="block font-medium hover:text-brand">
                        {lead.personName}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        {lead.personPhone ?? lead.personEmail ?? "No contact details"}
                      </p>
                      <p className="mt-1.5 flex flex-wrap gap-1">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${SOURCE_TONE[lead.source] ?? "bg-surface-muted text-ink-muted"}`}>
                          {LEAD_SOURCE_LABELS[lead.source]}
                        </span>
                        {lead.isTest && <span className="rounded bg-caution-soft px-1.5 py-0.5 text-[11px] font-medium text-caution">Test</span>}
                        <SlaBadge lead={lead} />
                      </p>
                      <p className="mt-1 truncate text-xs text-ink-subtle">
                        {lead.ownerName ?? "Unassigned"} · {relativeTime(lead.createdAt)}
                      </p>
                      <div className="mt-2 flex justify-end">
                        {canMove && (
                          <label className="shrink-0">
                            <span className="sr-only">Move {lead.personName} to</span>
                            <select
                              value=""
                              onChange={(e) => {
                                const target = stages.find((s) => s.id === e.target.value);
                                if (target) move(lead, target);
                              }}
                              className="cursor-pointer rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink-muted hover:border-line-strong"
                            >
                              <option value="" disabled>
                                Move…
                              </option>
                              {stages
                                .filter((s) => s.id !== lead.stageId && canMoveTo(lead, s))
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                      </div>
                    </li>
                  ))}
                  {total > cards.length && (
                    <li className="px-2 text-xs text-ink-subtle">+ {total - cards.length} more in the list view</li>
                  )}
                  {cards.length === 0 && (
                    <li className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-xs text-ink-subtle">
                      {canMove ? "Drop a lead here" : "Empty"}
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      </div>

      <dialog
        ref={dialogRef}
        onClose={() => setAsking(null)}
        className="m-auto w-[min(420px,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-[var(--shadow-pop)] backdrop:bg-black/30"
      >
        {asking && (
          <form
            method="dialog"
            onSubmit={(e) => {
              const reason = new FormData(e.currentTarget).get("reason")?.toString() ?? "";
              if (reason.trim()) move(asking.lead, asking.stage, reason);
            }}
            className="flex flex-col gap-4 p-5"
          >
            <div>
              <h2 className="text-base font-semibold">Why is {asking.lead.personName} {asking.stage.name.toLowerCase()}?</h2>
              <p className="mt-1 text-sm text-ink-muted">A short reason helps when you look back at what isn&rsquo;t working.</p>
            </div>
            <input list="loss-reasons" name="reason" required autoFocus placeholder="Pick or type a reason" className={inputClasses} />
            <datalist id="loss-reasons">
              {LOSS_REASONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => dialogRef.current?.close()} className={buttonClasses("ghost")}>
                Cancel
              </button>
              <button type="submit" className={buttonClasses("primary")}>
                Move to {asking.stage.name}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
