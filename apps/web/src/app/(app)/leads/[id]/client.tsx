"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  CONTACT_ATTEMPT_OUTCOMES,
  TASK_OUTCOMES,
  TASK_PRIORITIES,
  type TaskDto,
} from "@skincrm/contracts";
import { Badge, Field, inputClasses } from "@/components/ui";
import {
  addLeadNoteAction,
  assignLeadAction,
  changeStageAction,
  completeTaskAction,
  createTaskAction,
  logContactAttemptAction,
  type ActionState,
} from "@/lib/crm-actions";
import type { PipelineStage } from "@/lib/crm";

const idle: ActionState = { status: "idle" };

const humanize = (value: string) => value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function LeadActions({
  leadId,
  stages,
  currentStageId,
  staff,
  currentOwnerId,
  canAssign,
}: {
  leadId: string;
  stages: PipelineStage[];
  currentStageId: string;
  staff: { id: string; fullName: string }[];
  currentOwnerId: string | null;
  canAssign: boolean;
}) {
  const [stageState, stageAction] = useActionState(changeStageAction, idle);
  const [assignState, assignAction] = useActionState(assignLeadAction, idle);

  const [selectedStageId, setSelectedStageId] = useState(currentStageId);
  const selected = stages.find((s) => s.id === selectedStageId);

  return (
    <div className="flex flex-col gap-4">
      <form action={stageAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="leadId" value={leadId} />
        <div className="flex flex-col gap-1">
          <label htmlFor="stageId" className="text-xs font-medium text-ink-muted">
            Move to stage
          </label>
          <select
            id="stageId"
            name="stageId"
            value={selectedStageId}
            onChange={(e) => setSelectedStageId(e.target.value)}
            className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>

        {/* Shown only when the chosen stage needs one, so the field appears at
            the moment it becomes relevant rather than always (PRD LEAD-02). */}
        {selected?.requiresReason && (
          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label htmlFor="reason" className="text-xs font-medium text-ink-muted">
              Reason (required for {selected.name})
            </label>
            <input
              id="reason"
              name="reason"
              required
              className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
            />
          </div>
        )}

        <Submit label="Update stage" />
        <Feedback state={stageState} />
      </form>

      {canAssign && (
        <form action={assignAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="leadId" value={leadId} />
          <div className="flex flex-col gap-1">
            <label htmlFor="ownerUserId" className="text-xs font-medium text-ink-muted">
              Owner
            </label>
            <select
              id="ownerUserId"
              name="ownerUserId"
              defaultValue={currentOwnerId ?? ""}
              className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
            >
              <option value="">Unassigned queue</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.fullName}
                </option>
              ))}
            </select>
          </div>
          <Submit label="Assign" subtle />
          <Feedback state={assignState} />
        </form>
      )}
    </div>
  );
}

export function ContactAttemptForm({ leadId }: { leadId: string }) {
  const [state, action] = useActionState(logContactAttemptAction, idle);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="outcome" className="text-xs font-medium text-ink-muted">
            Outcome
          </label>
          <select
            id="outcome"
            name="outcome"
            className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
          >
            {CONTACT_ATTEMPT_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {humanize(outcome)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="channel" className="text-xs font-medium text-ink-muted">
            Channel
          </label>
          <select
            id="channel"
            name="channel"
            className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
          >
            {["phone", "email", "whatsapp", "in_person"].map((channel) => (
              <option key={channel} value={channel}>
                {humanize(channel)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Field label="Note" htmlFor="note">
        <textarea id="note" name="note" rows={2} className={inputClasses} />
      </Field>
      <div className="flex items-center gap-3">
        <Submit label="Log attempt" />
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function InquiryNoteForm({ leadId }: { leadId: string }) {
  const [state, action] = useActionState(addLeadNoteAction, idle);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <Field label="Note" htmlFor="body">
        <textarea id="body" name="body" rows={3} required className={inputClasses} />
      </Field>
      <div className="flex items-center gap-3">
        <Submit label="Add note" />
        <Feedback state={state} />
      </div>
    </form>
  );
}

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
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
        subtle
          ? "border border-line-strong hover:bg-surface-muted"
          : "bg-brand text-white hover:bg-brand-hover"
      }`}
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
