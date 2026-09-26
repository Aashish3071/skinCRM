"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { PASSWORD_MIN_LENGTH } from "@skincrm/contracts";
import { Field, inputClasses } from "@/components/ui";
import { setPasswordAction, type SetPasswordState } from "./set-password-actions";

export function SetPasswordForm({ mode, token }: { mode: "reset" | "invite"; token: string }) {
  const [state, action] = useActionState(setPasswordAction, { status: "idle" } as SetPasswordState);
  const errors = state.status === "error" ? state.fieldErrors : undefined;

  if (state.status === "done") {
    return (
      <div role="status" className="flex flex-col gap-4">
        <p className="text-sm">
          {mode === "invite" ? "Your account is ready." : "Your password has been changed."} You can sign in now.
        </p>
        <Link href="/login" className="rounded-md bg-brand px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-brand-hover">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="token" value={token} />
      {mode === "invite" && (
        <Field label="Your name" htmlFor="fullName" errors={errors?.fullName}>
          <input id="fullName" name="fullName" autoComplete="name" required autoFocus className={inputClasses} />
        </Field>
      )}
      <Field
        label="New password"
        htmlFor="password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`}
        errors={errors?.password}
      >
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          autoFocus={mode === "reset"}
          className={inputClasses}
        />
      </Field>
      <Field label="Type it again" htmlFor="confirm" errors={errors?.confirm}>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required className={inputClasses} />
      </Field>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-critical">
          {state.message}
        </p>
      )}
      <Submit label={mode === "invite" ? "Create my account" : "Save new password"} />
    </form>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

export function SetPasswordShell({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-ink-muted">{lead}</p>
      <div className="mt-6 rounded-card border border-line bg-surface p-6">{children}</div>
    </main>
  );
}
