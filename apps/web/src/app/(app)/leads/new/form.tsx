"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "@skincrm/contracts";
import { Field, inputClasses } from "@/components/ui";
import { createLeadAction, type ActionState } from "@/lib/crm-actions";

/** Sources a person can select by hand. The rest arrive from an integration. */
const MANUAL_SOURCES = LEAD_SOURCES.filter((source) =>
  ["walk_in", "phone", "referral", "manual"].includes(source),
);

export function NewLeadForm() {
  const [state, action] = useActionState(createLeadAction, { status: "idle" } as ActionState);
  const duplicateWarning = state.status === "error" && state.message.includes("already exists");

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="firstName">
          <input id="firstName" name="firstName" autoFocus className={inputClasses} />
        </Field>
        <Field label="Last name" htmlFor="lastName">
          <input id="lastName" name="lastName" className={inputClasses} />
        </Field>
        <Field
          label="Phone"
          htmlFor="phone"
          hint="Any format. It is normalized for matching and kept as typed."
          errors={state.status === "error" ? state.fieldErrors?.phone : undefined}
        >
          <input id="phone" name="phone" inputMode="tel" className={inputClasses} />
        </Field>
        <Field label="Email" htmlFor="email">
          <input id="email" name="email" type="email" className={inputClasses} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Source" htmlFor="source">
          <select id="source" name="source" defaultValue="walk_in" className={inputClasses}>
            {MANUAL_SOURCES.map((source) => (
              <option key={source} value={source}>
                {LEAD_SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service interest" htmlFor="serviceInterest">
          <input
            id="serviceInterest"
            name="serviceInterest"
            placeholder="Consultation"
            className={inputClasses}
          />
        </Field>
      </div>

      <Field
        label="What they asked about"
        htmlFor="inquiryNote"
        hint="Specific to this inquiry. Context that should follow them everywhere belongs in General Notes."
      >
        <textarea id="inquiryNote" name="inquiryNote" rows={3} className={inputClasses} />
      </Field>

      {state.status === "error" && (
        <div
          role="alert"
          className="rounded-md bg-critical-soft px-3 py-2.5 text-sm text-critical"
        >
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
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
    >
      {pending ? "Saving…" : "Create inquiry"}
    </button>
  );
}
