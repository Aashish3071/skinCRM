"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { isValidEmail, nameProblem, phoneShapeProblem, sanitizePhoneInput } from "@skincrm/contracts";
import { inputClasses } from "./ui";

/**
 * Inputs for contact details, used by every form that takes them (D-89).
 * The rules are the same ones the API enforces (packages/contracts/src/contact.ts),
 * so what the browser accepts, the server accepts.
 *
 *  - PhoneInput refuses letters as you type (and on paste) and says so.
 *  - EmailInput needs a whole address. Digits are allowed — jane85@gmail.com
 *    is a real address — but "12345" or "jane@gmail" are not.
 *  - NameInput refuses digits.
 *
 * Each checks when you leave the field, blocks submit with the same message
 * (setCustomValidity), and shows it under the field for screen readers too.
 */

type Base = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value" | "defaultValue" | "className"> & {
  id: string;
  name: string;
  defaultValue?: string | null;
  className?: string;
};

function useFieldMessage(check: (value: string) => string | null) {
  const [message, setMessage] = useState<string | null>(null);
  const validate = (el: HTMLInputElement) => {
    const value = el.value.trim();
    const problem = value ? check(value) : null;
    el.setCustomValidity(problem ?? "");
    setMessage(problem);
    return problem;
  };
  return { message, validate, clear: (el: HTMLInputElement) => { el.setCustomValidity(""); setMessage(null); } };
}

function Message({ id, text, tone = "critical" }: { id: string; text: string | null; tone?: "critical" | "muted" }) {
  return (
    <p id={id} aria-live="polite" className={`mt-1 min-h-0 text-xs ${tone === "critical" ? "text-critical" : "text-ink-muted"}`}>
      {text}
    </p>
  );
}

export function PhoneInput({ id, name, defaultValue, className, ...rest }: Base) {
  const messageId = useId();
  const initial = defaultValue ?? "";
  const [value, setValue] = useState(initial);
  const [removed, setRemoved] = useState(false);
  // An old value (say an imported "ask at desk") is only checked once it's edited.
  const { message, validate, clear } = useFieldMessage((v) => (v === initial.trim() ? null : phoneShapeProblem(v)));
  return (
    <>
      <input
        {...rest}
        id={id}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete={rest.autoComplete ?? "tel"}
        maxLength={25}
        value={value}
        aria-invalid={message ? true : undefined}
        aria-describedby={[rest["aria-describedby"], messageId].filter(Boolean).join(" ")}
        onChange={(e) => {
          const cleaned = sanitizePhoneInput(e.target.value);
          setRemoved(cleaned !== e.target.value);
          setValue(cleaned);
          clear(e.target);
        }}
        onBlur={(e) => { setRemoved(false); validate(e.target); }}
        onInvalid={(e) => validate(e.currentTarget)}
        placeholder={rest.placeholder ?? "(305) 555-0123"}
        className={className ?? inputClasses}
      />
      <Message id={messageId} text={message ?? (removed ? "Only digits, spaces, +, -, ( and ) can go in a phone number." : null)} tone={message ? "critical" : "muted"} />
    </>
  );
}

export function EmailInput({ id, name, defaultValue, className, ...rest }: Base) {
  const messageId = useId();
  const initial = (defaultValue ?? "").trim();
  const { message, validate, clear } = useFieldMessage((v) => (v === initial || isValidEmail(v) ? null : "Enter a full email address, like name@example.com."));
  return (
    <>
      <input
        {...rest}
        id={id}
        name={name}
        // An old invalid value must not make the browser block an unrelated save.
        type={initial && !isValidEmail(initial) ? "text" : "email"}
        inputMode="email"
        autoComplete={rest.autoComplete ?? "email"}
        autoCapitalize="none"
        spellCheck={false}
        maxLength={320}
        defaultValue={defaultValue ?? ""}
        aria-invalid={message ? true : undefined}
        aria-describedby={[rest["aria-describedby"], messageId].filter(Boolean).join(" ")}
        onChange={(e) => { if (message) clear(e.target); }}
        onBlur={(e) => validate(e.target)}
        onInvalid={(e) => validate(e.currentTarget)}
        placeholder={rest.placeholder ?? "name@example.com"}
        className={className ?? inputClasses}
      />
      <Message id={messageId} text={message} />
    </>
  );
}

export function NameInput({ id, name, defaultValue, className, ...rest }: Base) {
  const messageId = useId();
  const { message, validate, clear } = useFieldMessage(nameProblem);
  return (
    <>
      <input
        {...rest}
        id={id}
        name={name}
        type="text"
        autoComplete={rest.autoComplete ?? "name"}
        maxLength={rest.maxLength ?? 120}
        defaultValue={defaultValue ?? ""}
        aria-invalid={message ? true : undefined}
        aria-describedby={[rest["aria-describedby"], messageId].filter(Boolean).join(" ")}
        onChange={(e) => { if (message) clear(e.target); }}
        onBlur={(e) => validate(e.target)}
        onInvalid={(e) => validate(e.currentTarget)}
        className={className ?? inputClasses}
      />
      <Message id={messageId} text={message} />
    </>
  );
}

/** Digits only (Meta ids, Google customer ids): letters never get in. */
export function DigitsInput({ id, name, defaultValue, className, allowDashes = false, ...rest }: Base & { allowDashes?: boolean }) {
  const [value, setValue] = useState(defaultValue ?? "");
  return (
    <input
      {...rest}
      id={id}
      name={name}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={value}
      onChange={(e) => setValue(e.target.value.replace(allowDashes ? /[^\d-]/g : /\D/g, ""))}
      className={className ?? inputClasses}
    />
  );
}
