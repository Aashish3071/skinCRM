"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "@/lib/auth-actions";
import { Field, inputClasses } from "@/components/ui";

const initialState: LoginState = { status: "idle" };

/** Seeded development accounts. Kept in step with `packages/db/src/scripts/seed.ts`. */
const DEV_ACCOUNTS = [
  { email: "admin@sunshine-skin.test", role: "Admin / owner" },
  { email: "frontdesk@sunshine-skin.test", role: "Front desk" },
  { email: "doctor@sunshine-skin.test", role: "Practitioner" },
  { email: "marketing@sunshine-skin.test", role: "Marketing analyst" },
] as const;

const DEV_PASSWORD = "ChangeMe-Dev-2026!";

export function LoginForm({ showDevAccounts = false }: { showDevAccounts?: boolean }) {
  const [state, formAction] = useActionState(loginAction, initialState);

  /**
   * Controlled so the development shortcuts can fill them exactly. Copying the
   * password out of a document is the usual way a dev sign-in fails: a trailing
   * space is invisible and passwords are deliberately not trimmed.
   */
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Step two of an MFA or multi-clinic sign-in. The credentials ride along in
  // hidden fields so the second submit is a complete request; nothing is held in
  // browser storage or a URL.
  const isSecondStep = state.status === "mfa_required" || state.status === "choose_clinic";

  return (
    <div className="flex flex-col gap-6">
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
              <summary className="cursor-pointer text-brand">Lost your authenticator?</summary>
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
          <p role="alert" className="rounded-md bg-critical-soft px-3 py-2.5 text-sm text-critical">
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

      {showDevAccounts && !isSecondStep && (
        <div className="rounded-md border border-dashed border-line-strong px-4 py-3">
          <p className="text-xs font-medium">Development accounts</p>
          <p className="mt-1 text-xs text-ink-muted">
            Click one to fill the form. Typing or pasting the password by hand is the usual way this
            fails — a trailing space is invisible, and passwords are deliberately not trimmed.
          </p>
          <ul className="mt-2.5 flex flex-col gap-1.5">
            {DEV_ACCOUNTS.map((account) => (
              <li key={account.email}>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(DEV_PASSWORD);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded border border-line px-2 py-1.5 text-left text-xs hover:bg-surface-muted"
                >
                  <span className="font-mono">{account.email}</span>
                  <span className="shrink-0 text-ink-subtle">{account.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
