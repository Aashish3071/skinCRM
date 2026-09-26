"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { PersonPicker, type PickedPerson } from "@/components/person-picker";
import { buttonClasses, inputClasses } from "@/components/ui";
import { addNoteAction, type ActionState } from "@/lib/crm-actions";

/**
 * Write a note in two steps: who it's about, then what to remember. Pinning
 * is a plain checkbox with an explanation, not an icon to decode.
 */
export function NoteComposer({ initialPerson }: { initialPerson: PickedPerson | null }) {
  const [person, setPerson] = useState<PickedPerson | null>(initialPerson);
  const [state, action] = useActionState(addNoteAction, { status: "idle" } as ActionState);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={action} className="flex flex-col gap-4">
      <PersonPicker value={person} onChange={setPerson} label="Who is this about?" />
      {person && <input type="hidden" name="personId" value={person.id} />}
      <div>
        <label htmlFor="note-body" className="text-sm font-medium">
          Note
        </label>
        <textarea
          id="note-body"
          name="body"
          rows={3}
          required
          disabled={!person}
          placeholder={person ? `Something to remember about ${person.name}` : "Choose a patient first"}
          className={`${inputClasses} mt-1.5 leading-relaxed`}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 text-sm">
          <input type="checkbox" name="pinned" disabled={!person} />
          <span>
            Pin it <span className="text-ink-subtle">— shows first, every time anyone opens this patient</span>
          </span>
        </label>
        <Save disabled={!person} />
      </div>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-critical">
          {state.message}
        </p>
      )}
      {state.status === "success" && (
        <p role="status" className="text-sm text-positive">
          Saved to {person?.name}&rsquo;s notes.
        </p>
      )}
    </form>
  );
}

function Save({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} className={buttonClasses("primary")}>
      {pending ? "Saving…" : "Save note"}
    </button>
  );
}
