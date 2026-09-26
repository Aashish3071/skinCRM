"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  TASK_OUTCOMES,
  TASK_PRIORITIES,
  type TaskDto,
} from "@skincrm/contracts";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import {
  addLeadNoteAction,
  completeTaskAction,
  createTaskAction,
  logContactAttemptAction,
  type ActionState,
} from "@/lib/crm-actions";

const idle: ActionState = { status: "idle" };

const humanize = (value: string) => value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function AddTaskForm({ leadId }: { leadId: string }) {
  const [state, action] = useActionState(createTaskAction, idle);
  // Default to tomorrow morning: a follow-up with no date is a follow-up that
  // never happens, and "tomorrow" is the common case.
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setHours(9, 0, 0, 0);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <Field label="New task" htmlFor="title">
        <input id="title" name="title" required placeholder="Call back" className={inputClasses} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label="Due" htmlFor="dueAt">
          <input
            id="dueAt"
            name="dueAt"
            type="datetime-local"
            required
            defaultValue={toLocalInput(tomorrow)}
            className={inputClasses}
          />
        </Field>
        <Field label="Priority" htmlFor="priority">
          <select id="priority" name="priority" defaultValue="normal" className={inputClasses}>
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {humanize(priority)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Submit label="Add task" subtle />
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function TaskRow({
  task,
  leadId,
  canWrite,
}: {
  task: TaskDto;
  leadId: string;
  canWrite: boolean;
}) {
  const [state, action] = useActionState(completeTaskAction, idle);
  const [completing, setCompleting] = useState(false);
  const overdue = task.status === "open" && new Date(task.dueAt).getTime() < Date.now();

  return (
    <li className="border-b border-line pb-3 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={`text-sm ${task.status === "completed" ? "text-ink-subtle line-through" : ""}`}>
            {task.title}
          </p>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Due {new Date(task.dueAt).toLocaleString()}
            {task.ownerName ? ` · ${task.ownerName}` : ""}
          </p>
        </div>
        {task.status === "completed" ? (
          <Badge tone="positive">Done</Badge>
        ) : overdue ? (
          <Badge tone="critical">Overdue</Badge>
        ) : (
          <Badge>Open</Badge>
        )}
      </div>

      {task.status === "completed" && task.outcome && (
        <p className="mt-1 text-xs text-ink-muted">Outcome: {humanize(task.outcome)}</p>
      )}

      {canWrite && task.status !== "completed" && (
        <div className="mt-2">
          {completing ? (
            <form action={action} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="leadId" value={leadId} />
              <div className="flex flex-col gap-1">
                <label htmlFor={`outcome-${task.id}`} className="text-xs font-medium text-ink-muted">
                  Outcome (required)
                </label>
                <select
                  id={`outcome-${task.id}`}
                  name="outcome"
                  className="rounded-md border border-line-strong bg-surface px-2 py-1 text-sm"
                >
                  {TASK_OUTCOMES.map((outcome) => (
                    <option key={outcome} value={outcome}>
                      {humanize(outcome)}
                    </option>
                  ))}
                </select>
              </div>
              <Submit label="Save" subtle />
              <button
                type="button"
                onClick={() => setCompleting(false)}
                className="px-2 py-1 text-sm text-ink-muted"
              >
                Cancel
              </button>
              <Feedback state={state} />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCompleting(true)}
              className="rounded-md border border-line-strong px-2.5 py-1 text-xs hover:bg-surface-muted"
            >
              Complete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function Submit({ label, subtle = false }: { label: string; subtle?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={buttonClasses(subtle ? "secondary" : "primary", "sm")}
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

function Feedback({ state }: { state: ActionState }) {
  if (state.status === "idle") return null;
  const isError = state.status === "error";
  if (!isError && !state.message) return null;
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`text-sm ${isError ? "text-critical" : "text-positive"}`}
    >
      {isError ? state.message : state.message}
    </p>
  );
}

/** `datetime-local` wants local wall-clock time with no zone suffix. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CALL_OUTCOMES = [
  { value: "connected", label: "Reached them" },
  { value: "no_answer", label: "No answer" },
  { value: "invalid_contact", label: "Wrong number" },
] as const;

/**
 * One box for the two things staff record most: a note, or a contact attempt.
 * Tabs instead of two separate cards, so the page has one obvious place to
 * type.
 */
export function QuickLog({ leadId }: { leadId: string }) {
  const [tab, setTab] = useState<"note" | "call">("call");
  const [noteState, noteAction] = useActionState(addLeadNoteAction, idle);
  const [callState, callAction] = useActionState(logContactAttemptAction, idle);
  const [outcome, setOutcome] = useState<string>("connected");

  return (
    <div>
      <div role="tablist" aria-label="Log" className="mb-3 flex gap-1 border-b border-line">
        {(
          [
            ["call", "Log a contact"],
            ["note", "Add a note"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-3 pb-2 text-sm ${
              tab === value ? "border-brand font-medium text-brand" : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "call" ? (
        <form action={callAction} role="tabpanel" className="flex flex-col gap-3">
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="outcome" value={outcome} />
          <div className="flex flex-wrap items-center gap-2">
            {CALL_OUTCOMES.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={outcome === o.value}
                onClick={() => setOutcome(o.value)}
                className={`min-h-9 rounded-full border px-3.5 text-sm ${
                  outcome === o.value
                    ? "border-brand bg-brand-soft font-medium text-brand"
                    : "border-line-strong text-ink-muted hover:bg-surface-muted"
                }`}
              >
                {o.label}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-2 text-sm text-ink-muted">
              via
              <select name="channel" defaultValue="phone" className="min-h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink">
                <option value="phone">Phone</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
                <option value="in_person">In person</option>
              </select>
            </label>
          </div>
          <label htmlFor="call-note" className="sr-only">
            Note
          </label>
          <textarea id="call-note" name="note" rows={2} placeholder="Anything worth remembering (optional)" className={inputClasses} />
          <div className="flex items-center gap-3">
            <Submit label="Save" />
            <Feedback state={callState} />
          </div>
        </form>
      ) : (
        <form action={noteAction} role="tabpanel" className="flex flex-col gap-3">
          <input type="hidden" name="leadId" value={leadId} />
          <label htmlFor="lead-note" className="sr-only">
            Note
          </label>
          <textarea
            id="lead-note"
            name="body"
            rows={3}
            required
            placeholder="A note about this inquiry"
            className={inputClasses}
          />
          <div className="flex items-center gap-3">
            <Submit label="Add note" />
            <Feedback state={noteState} />
          </div>
        </form>
      )}
    </div>
  );
}
