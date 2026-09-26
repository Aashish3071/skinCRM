"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Field, inputClasses } from "@/components/ui";
import type { ResetState } from "./actions";

export function ForgotPasswordForm({
  action,
}: {
  action: (previous: ResetState, formData: FormData) => Promise<ResetState>;
}) {
  const [state, formAction] = useActionState(action, { status: "idle" } as ResetState);

  if (state.status === "sent") {
    return (
      <p role="status" className="text-sm">
        If that email belongs to an account, a reset link is on its way. The link expires in one hour.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Email" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className={inputClasses}
        />
      </Field>

      {state.status === "error" && (
        <p role="alert" className="text-sm text-critical">
          {state.message}
        </p>
      )}

      <Submit />
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
      {pending ? "Sending…" : "Send reset link"}
    </button>
  );
}
