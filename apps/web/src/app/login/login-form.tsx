"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "@/lib/auth-actions";
import { Field, inputClasses } from "@/components/ui";

const initialState: LoginState = { status: "idle" };

export function LoginForm() {
  const [state, formAction] = useActionState(loginAction, initialState);

  // Step two of an MFA or multi-clinic sign-in. The credentials ride along in
  // hidden fields so the second submit is a complete request; nothing is held in
  // browser storage or a URL.
  const isSecondStep = state.status === "mfa_required" || state.status === "choose_clinic";

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {isSecondStep ? (
        <>
          <input type="hidden" name="email" value={state.email} />
          <input type="hidden" name="password" value={state.password} />
        </>
      ) : (
        <>
          <Field label="Email" htmlFor="email" errors={fieldErrors(state, "email")}>
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

          <Field label="Password" htmlFor="password" errors={fieldErrors(state, "password")}>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={inputClasses}
            />
          </Field>
        </>
      )}

      {state.status === "mfa_required" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">
            Enter the 6-digit code from your authenticator app.
          </p>
          <Field label="Authentication code" htmlFor="totpCode">
            <input
              id="totpCode"
              name="totpCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              autoFocus
              className={inputClasses}
            />
          </Field>
          <details className="text-sm">
            <summary className="cursor-pointer text-brand">
              Lost your authenticator?
            </summary>
            <div className="mt-3">
              <Field
                label="Recovery code"
                htmlFor="recoveryCode"
                hint="One of the codes you saved when you set up two-factor sign-in. Each works once."
              >
                <input id="recoveryCode" name="recoveryCode" className={inputClasses} />
              </Field>
            </div>
          </details>
        </div>
      )}

      {state.status === "choose_clinic" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-muted">
            That email is used at more than one clinic. Choose where to sign in.
          </p>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Clinic</legend>
            {state.clinics.map((clinic, index) => (
              <label
                key={clinic.id}
                className="flex items-center gap-2.5 rounded-md border border-line-strong px-3 py-2.5 text-sm"
              >
                <input
                  type="radio"
                  name="clinicId"
                  value={clinic.id}
                  defaultChecked={index === 0}
                  required
                />
                <span>{clinic.name}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {state.status === "error" && (
        <p
          role="alert"
          className="rounded-md bg-critical-soft px-3 py-2.5 text-sm text-critical"
        >
          {state.message}
        </p>
      )}

      <SubmitButton label={isSecondStep ? "Continue" : "Sign in"} />

      {!isSecondStep && (
        <a href="/forgot-password" className="text-center text-sm text-brand">
          Forgot your password?
        </a>
      )}
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
    >
      {pending ? "Signing in…" : label}
    </button>
  );
}

function fieldErrors(state: LoginState, field: string): string[] | undefined {
  return state.status === "error" ? state.fieldErrors?.[field] : undefined;
}
