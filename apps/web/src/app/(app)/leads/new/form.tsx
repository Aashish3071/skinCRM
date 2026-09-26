"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { LEAD_SOURCE_LABELS, type LeadSource } from "@skincrm/contracts";
import { Field, buttonClasses, inputClasses } from "@/components/ui";
import { createLeadAction, type ActionState } from "@/lib/crm-actions";

/**
 * Adding a lead by hand: a walk-in or a phone call.
 *
 * Three things matter at the desk — who, how to reach them, and how they found
 * the clinic. Everything else (owner, stage) is decided for them, and extra
 * detail lives behind "Add a note" so the form fits on a tablet without
 * scrolling.
 */
const SOURCES: LeadSource[] = ["walk_in", "phone", "referral", "manual"];
const SOURCE_TEXT: Partial<Record<LeadSource, string>> = { manual: "Other" };

export function NewLeadForm() {
  const [state, action] = useActionState(createLeadAction, { status: "idle" } as ActionState);
  const [source, setSource] = useState<LeadSource>("walk_in");
  const [showNote, setShowNote] = useState(false);
  const errors = state.status === "error" ? state.fieldErrors : undefined;
  const duplicateWarning = state.status === "error" && state.message.includes("already exists");

  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Name" htmlFor="fullName" errors={errors?.["person.firstName"] ?? errors?.firstName}>
        <input id="fullName" name="fullName" required autoFocus autoComplete="off" placeholder="e.g. Maria Lopez" className={inputClasses} />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Phone" htmlFor="phone" errors={errors?.["person.phone"] ?? errors?.phone}>
          <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="off" className={inputClasses} />
        </Field>
        <Field label="Email" htmlFor="email" errors={errors?.["person.email"] ?? errors?.email}>
          <input id="email" name="email" type="email" autoComplete="off" className={inputClasses} />
        </Field>
      </div>
      <p className="-mt-3 text-xs text-ink-subtle">A phone number or an email is enough.</p>

      <fieldset>
        <legend className="text-sm font-medium">How did they find you?</legend>
        <input type="hidden" name="source" value={source} />
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Source">
          {SOURCES.map((value) => {
            const selected = value === source;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setSource(value)}
                className={`min-h-10 rounded-full border px-4 text-sm transition-colors ${
                  selected
                    ? "border-brand bg-brand-soft font-medium text-brand"
                    : "border-line-strong text-ink-muted hover:bg-surface-muted"
                }`}
              >
                {SOURCE_TEXT[value] ?? LEAD_SOURCE_LABELS[value]}
              </button>
            );
          })}
        </div>
      </fieldset>

      {showNote ? (
        <Field label="Note" htmlFor="inquiryNote" hint="What they asked about. Kept with this inquiry.">
          <textarea id="inquiryNote" name="inquiryNote" rows={3} autoFocus className={inputClasses} />
        </Field>
      ) : (
        <button type="button" onClick={() => setShowNote(true)} className="self-start text-sm font-medium text-brand">
          + Add a note
        </button>
      )}

      {state.status === "error" && (
        <div role="alert" className="rounded-lg bg-critical-soft px-3 py-2.5 text-sm text-critical">
          <p>{state.message}</p>
          {duplicateWarning && (
            <label className="mt-2 flex items-center gap-2 text-ink">
              <input type="checkbox" name="allowDuplicate" value="true" />
              This is a different person — create a new record
            </label>
          )}
        </div>
      )}

      <div>
        <Submit />
      </div>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClasses("primary")}>
      {pending ? "Saving…" : "Add lead"}
    </button>
  );
}
