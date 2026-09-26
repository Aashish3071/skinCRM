"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { buttonClasses, inputClasses } from "@/components/ui";
import { assignLeadAction, moveLeadAction } from "@/lib/crm-actions";
import type { BoardStage } from "../board";

const LOSS_REASONS = ["Not interested", "Went to another clinic", "Price", "Never replied", "Not a fit"];

/**
 * The lead's stage as a row of steps: click one to move there.
 *
 * Replaces a dropdown plus an "Update stage" button — two controls and a
 * decision for what is really one tap. Closed outcomes (Won, Lost) sit apart
 * on the right so nobody closes a lead by overshooting the next step.
 */
export function StageStepper({
  leadId,
  stages,
  currentStageId,
  canMove,
}: {
  leadId: string;
  stages: BoardStage[];
  currentStageId: string;
  canMove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<BoardStage | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useOptimistic(currentStageId);

  const open = stages.filter((s) => !s.isClosed);
  const closed = stages.filter((s) => s.isClosed);
  const currentIndex = open.findIndex((s) => s.id === current);

  const move = (stage: BoardStage, reason?: string) => {
    if (!canMove || stage.id === current) return;
    if (stage.requiresReason && !reason) {
      setAsking(stage);
      dialogRef.current?.showModal();
      return;
    }
    setError(null);
    startTransition(async () => {
      setCurrent(stage.id);
      const result = await moveLeadAction(leadId, stage.id, reason);
      if (result.status === "error") setError(result.message);
      router.refresh();
    });
  };

  return (
    <div aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-2">
        <ol className="flex flex-1 flex-wrap gap-1.5" aria-label="Stage">
          {open.map((stage, index) => {
            const isCurrent = stage.id === current;
            const done = currentIndex >= 0 && index < currentIndex;
            return (
              <li key={stage.id} className="min-w-[88px] flex-1">
                <button
                  type="button"
                  disabled={!canMove}
                  aria-current={isCurrent ? "step" : undefined}
                  onClick={() => move(stage)}
                  className={`flex min-h-10 w-full items-center justify-center rounded-lg px-3 text-sm transition-colors ${
                    isCurrent
                      ? "bg-brand font-medium text-on-brand"
                      : done
                        ? "bg-brand-soft text-brand hover:bg-brand-soft/70"
                        : "border border-line-strong text-ink-muted hover:bg-surface-muted"
                  }`}
                >
                  {done && <span aria-hidden="true" className="mr-1">✓</span>}
                  {stage.name}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="flex gap-1.5">
          {closed.map((stage) => {
            const isCurrent = stage.id === current;
            const won = stage.category === "converted";
            return (
              <button
                key={stage.id}
                type="button"
                disabled={!canMove}
                aria-pressed={isCurrent}
                onClick={() => move(stage)}
                className={`min-h-10 rounded-lg border px-4 text-sm font-medium transition-colors ${
                  isCurrent
                    ? won
                      ? "border-positive bg-positive-soft text-positive"
                      : "border-critical bg-critical-soft text-critical"
                    : won
                      ? "border-line-strong text-positive hover:bg-positive-soft"
                      : "border-line-strong text-critical hover:bg-critical-soft"
                }`}
              >
                {stage.name}
              </button>
            );
          })}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      )}

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
              if (reason.trim()) move(asking, reason);
            }}
            className="flex flex-col gap-4 p-5"
          >
            <h2 className="text-base font-semibold">What happened?</h2>
            <input list="stepper-loss-reasons" name="reason" required autoFocus placeholder="Pick or type a reason" className={inputClasses} />
            <datalist id="stepper-loss-reasons">
              {LOSS_REASONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => dialogRef.current?.close()} className={buttonClasses("ghost")}>
                Cancel
              </button>
              <button type="submit" className={buttonClasses("primary")}>
                Mark {asking.name.toLowerCase()}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

/** Owner picker that saves as soon as you choose — no separate Assign button. */
export function OwnerPicker({
  leadId,
  staff,
  currentOwnerId,
}: {
  leadId: string;
  staff: { id: string; fullName: string }[];
  currentOwnerId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor="owner" className="text-ink-muted">
        Owner
      </label>
      <select
        id="owner"
        defaultValue={currentOwnerId ?? ""}
        disabled={pending}
        onChange={(e) => {
          const form = new FormData();
          form.set("leadId", leadId);
          form.set("ownerUserId", e.target.value);
          startTransition(async () => {
            const result = await assignLeadAction({ status: "idle" }, form);
            setMessage(result.status === "error" ? result.message : "Saved");
            router.refresh();
          });
        }}
        className="min-h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm"
      >
        <option value="">Unassigned</option>
        {staff.map((member) => (
          <option key={member.id} value={member.id}>
            {member.fullName}
          </option>
        ))}
      </select>
      <span role="status" className="text-xs text-ink-subtle">
        {pending ? "Saving…" : message}
      </span>
    </div>
  );
}
