"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { NoteDto } from "@skincrm/contracts";
import { Badge, Card, EmptyState, Field, inputClasses } from "@/components/ui";
import {
  addNoteAction,
  archiveNoteAction,
  togglePinNoteAction,
  type ActionState,
} from "@/lib/crm-actions";

const idle: ActionState = { status: "idle" };

/**
 * General Notes (PRD ID-08).
 *
 * These belong to the person, not to any one inquiry, so they stay visible
 * across every lead that person ever opens. They are internal staff context
 * only: never sent to an ad platform, never interpolated into an automated
 * message, and never written to a log.
 */
export function NotesPanel({
  personId,
  notes,
  canWrite,
  canArchive,
}: {
  personId: string;
  notes: NoteDto[];
  canWrite: boolean;
  canArchive: boolean;
}) {
  const [state, action] = useActionState(addNoteAction, idle);

  return (
    <Card
      title="General Notes"
      description="Visible on every inquiry for this person. Internal only — never sent anywhere."
    >
      {canWrite && (
        <form action={action} className="mb-5 flex flex-col gap-3 border-b border-line pb-5">
          <input type="hidden" name="personId" value={personId} />
          <Field
            label="Add a note"
            htmlFor="body"
            hint="Contact preferences, availability, language, anything worth remembering next time."
          >
            <textarea id="body" name="body" rows={3} required className={inputClasses} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="pinned" />
              Pin to the top
            </label>
            <Submit label="Save note" />
            {state.status === "error" && (
              <p role="alert" className="text-sm text-critical">
                {state.message}
              </p>
            )}
          </div>
        </form>
      )}

      {notes.length === 0 ? (
        <EmptyState title="No notes yet">
          Anything staff should know before speaking to this person goes here.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-4">
          {notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              personId={personId}
              canWrite={canWrite}
              canArchive={canArchive}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NoteItem({
  note,
  personId,
  canWrite,
  canArchive,
}: {
  note: NoteDto;
  personId: string;
  canWrite: boolean;
  canArchive: boolean;
}) {
  const [pinState, pinAction] = useActionState(togglePinNoteAction, idle);
  const [archiveState, archiveAction] = useActionState(archiveNoteAction, idle);
  const feedback = pinState.status === "error" ? pinState : archiveState;

  return (
    <li className="border-b border-line pb-4 last:border-0 last:pb-0">
      {note.pinned && (
        <div className="mb-1.5">
          <Badge tone="caution">Pinned</Badge>
        </div>
      )}
      <p className="whitespace-pre-wrap text-sm">{note.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
        <span>
          {note.authorLabel ?? "Unknown"} · {new Date(note.createdAt).toLocaleString()}
        </span>
        {note.editedAt && <span>edited</span>}

        {canWrite && (
          <form action={pinAction} className="inline">
            <input type="hidden" name="noteId" value={note.id} />
            <input type="hidden" name="personId" value={personId} />
            <input type="hidden" name="pinned" value={note.pinned ? "false" : "true"} />
            <LinkButton label={note.pinned ? "Unpin" : "Pin"} />
          </form>
        )}

        {canArchive && (
          <form action={archiveAction} className="inline">
            <input type="hidden" name="noteId" value={note.id} />
            <input type="hidden" name="personId" value={personId} />
            {/* Archived, never deleted: the note stays part of the record. */}
            <LinkButton label="Archive" danger />
          </form>
        )}
      </div>
      {feedback.status === "error" && (
        <p role="alert" className="mt-1 text-xs text-critical">
          {feedback.message}
        </p>
      )}
    </li>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

function LinkButton({ label, danger = false }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`underline disabled:opacity-60 ${danger ? "text-critical" : "text-brand"}`}
    >
      {pending ? "…" : label}
    </button>
  );
}
