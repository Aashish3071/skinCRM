"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import type { TemplateDto } from "@skincrm/contracts";
import { Field, buttonClasses, inputClasses } from "@/components/ui";
import { saveTemplateAction } from "@/lib/template-actions";
import { friendlyVariable } from "../builder/inspector";

/** What the preview fills variables with. Obviously fake, so nobody mistakes it for a real client. */
const SAMPLE: Record<string, string> = {
  "person.firstName": "Maria",
  "person.fullName": "Maria Lopez",
  "clinic.name": "Your clinic",
  "clinic.phone": "(305) 555-0100",
  "clinic.address": "123 Main Street, Miami, FL",
  "appointment.date": "Tuesday, March 16",
  "appointment.time": "10:00 AM",
  "appointment.staffName": "Dr. Patel",
  "link.unsubscribe": "https://…/unsubscribe",
  "link.reschedule": "https://…/reschedule",
};

/** Promotional email must carry these by law (CAN-SPAM); added for the user, not asked of them. */
const REQUIRED_FOOTER = "\n\n—\n{{clinic.name}} · {{clinic.address}}\nUnsubscribe: {{link.unsubscribe}}";

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function render(text: string) {
  return text.replace(TOKEN, (_m, name: string) => SAMPLE[name] ?? `{{${name}}}`);
}

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "template";
}

/**
 * Write a template, and see it as the client will while you type.
 *
 * Variables go in with buttons ("First name"), never by typing curly braces.
 * The legally required marketing footer is added automatically.
 */
export function TemplateEditor({
  template,
  variables,
  canWrite,
}: {
  template: TemplateDto | null;
  variables: { name: string; description: string }[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(template?.name ?? "");
  const [channel, setChannel] = useState<"email" | "whatsapp">(template?.channel ?? "email");
  const [purpose, setPurpose] = useState<"operational" | "promotional">(template?.classification ?? "operational");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "Hi {{person.firstName}},\n\n");
  const [metaName, setMetaName] = useState(template?.whatsappTemplateName ?? "");
  const [active, setActive] = useState(template?.isActive ?? true);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string[]> } | null>(null);
  const [saved, setSaved] = useState(false);
  const focused = useRef<"subject" | "body">("body");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const needsFooter = channel === "email" && purpose === "promotional";
  const finalBody = needsFooter && !body.includes("link.unsubscribe") ? body.trimEnd() + REQUIRED_FOOTER : body;

  const unknown = useMemo(() => {
    const known = new Set(variables.map((v) => v.name));
    return [...`${subject} ${body}`.matchAll(TOKEN)].map((m) => m[1]!).filter((n) => !known.has(n));
  }, [subject, body, variables]);

  const insert = (variable: string) => {
    const token = `{{${variable}}}`;
    const target = focused.current === "subject" && channel === "email" ? subjectRef.current : bodyRef.current;
    const value = target === subjectRef.current ? subject : body;
    const set = target === subjectRef.current ? setSubject : setBody;
    const start = target?.selectionStart ?? value.length;
    const end = target?.selectionEnd ?? value.length;
    set(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveTemplateAction(template?.id ?? null, {
        key: template?.key ?? `${slug(name)}_${Date.now().toString(36).slice(-4)}`,
        name: name.trim(),
        channel,
        classification: purpose,
        subject: channel === "email" ? subject : null,
        body: finalBody,
        whatsappTemplateName: channel === "whatsapp" ? metaName || null : null,
        whatsappLanguageCode: "en",
        isActive: active,
      });
      if (result.status === "error") return setError({ message: result.message, fields: result.fieldErrors });
      setSaved(true);
      if (!template) router.replace(`/automations/templates/${result.template.id}`);
      else router.refresh();
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      <div className="flex flex-col gap-5">
        <Field label="Template name" htmlFor="t-name" hint="Only your team sees this." errors={error?.fields?.name}>
          <input id="t-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} placeholder="e.g. Booking confirmation" className={inputClasses} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Choice
            legend="Send by"
            value={channel}
            disabled={!canWrite || Boolean(template)}
            options={[
              ["email", "Email"],
              ["whatsapp", "WhatsApp"],
            ]}
            onChange={(v) => setChannel(v as "email" | "whatsapp")}
          />
          <Choice
            legend="Kind of message"
            value={purpose}
            disabled={!canWrite}
            options={[
              ["operational", "Service"],
              ["promotional", "Marketing"],
            ]}
            onChange={(v) => setPurpose(v as "operational" | "promotional")}
          />
        </div>
        <p className="-mt-3 text-xs text-ink-subtle">
          {purpose === "operational"
            ? "Service: confirmations, reminders and replies. Sent unless the person opted out."
            : "Marketing: offers and follow-ups. Only sent to people who agreed to marketing, once your clinic has approved marketing sends."}
        </p>

        {channel === "email" && (
          <Field label="Subject" htmlFor="t-subject" hint="Keep it general — no treatments or conditions." errors={error?.fields?.subject}>
            <input
              ref={subjectRef}
              id="t-subject"
              value={subject}
              disabled={!canWrite}
              onFocus={() => (focused.current = "subject")}
              onChange={(e) => setSubject(e.target.value)}
              className={inputClasses}
            />
          </Field>
        )}

        <Field label="Message" htmlFor="t-body" errors={error?.fields?.body}>
          <textarea
            ref={bodyRef}
            id="t-body"
            rows={10}
            value={body}
            disabled={!canWrite}
            onFocus={() => (focused.current = "body")}
            onChange={(e) => setBody(e.target.value)}
            className={`${inputClasses} leading-relaxed`}
          />
        </Field>

        {canWrite && (
          <div>
            <p className="text-sm font-medium">Add personal details</p>
            <p className="text-xs text-ink-subtle">
              Tap to insert where your cursor is. They appear in the message as words in double braces — for example
              {" {{person.firstName}} "}becomes each person&rsquo;s own first name. The preview shows how it will read.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {variables
                .filter((v) => !v.name.startsWith("link."))
                .map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    title={v.description}
                    onClick={() => insert(v.name)}
                    className="min-h-9 rounded-lg border border-line bg-surface-muted px-3 text-sm text-ink-muted hover:border-line-strong hover:text-ink"
                  >
                    + {friendlyVariable(v.name)}
                  </button>
                ))}
            </div>
          </div>
        )}

        {unknown.length > 0 && (
          <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
            These can&rsquo;t be filled in: {unknown.map((u) => `{{${u}}}`).join(", ")}. Remove them, or use the buttons above.
          </p>
        )}

        {channel === "whatsapp" && (
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Approved by Meta? (optional)</summary>
            <p className="mt-2 text-xs text-ink-muted">
              WhatsApp only lets you message people who haven&rsquo;t written to you in the last 24 hours with a template
              Meta has approved. If this one is, enter its name exactly as it appears in Meta.
            </p>
            <input value={metaName} onChange={(e) => setMetaName(e.target.value)} disabled={!canWrite} aria-label="Meta template name" placeholder="appointment_reminder" className={`${inputClasses} mt-2`} />
          </details>
        )}

        {template && (
          <label className="flex items-center gap-2.5 text-sm">
            <input type="checkbox" checked={active} disabled={!canWrite} onChange={(e) => setActive(e.target.checked)} />
            In use — untick to stop automations sending it
          </label>
        )}

        {error && !error.fields && (
          <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
            {error.message}
          </p>
        )}
        {saved && (
          <p role="status" className="rounded-lg bg-positive-soft px-3 py-2 text-sm text-positive">
            Saved.
          </p>
        )}

        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={pending || !name.trim() || !body.trim() || unknown.length > 0} className={buttonClasses("primary")}>
              {pending ? "Saving…" : template ? "Save changes" : "Create template"}
            </button>
            <Link href="/automations/templates" className={buttonClasses("ghost")}>
              Cancel
            </Link>
          </div>
        )}
      </div>

      <aside aria-label="Preview" className="lg:sticky lg:top-6 lg:self-start">
        <p className="mb-2 text-sm font-medium">Preview</p>
        <div className="overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow-card)]">
          {channel === "email" ? (
            <>
              <div className="border-b border-line px-4 py-3 text-sm">
                <p className="text-xs text-ink-subtle">To: maria@example.com</p>
                <p className="mt-0.5 font-semibold">{render(subject) || <span className="text-ink-subtle">No subject</span>}</p>
              </div>
              <p className="whitespace-pre-wrap px-4 py-4 text-sm leading-relaxed">{render(finalBody)}</p>
            </>
          ) : (
            <div className="bg-surface-muted p-4">
              <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-brand-soft px-3.5 py-2.5 text-sm leading-relaxed">
                {render(finalBody)}
              </p>
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-subtle">Shown with example details. Real messages use each person&rsquo;s own.</p>
        {needsFooter && <p className="mt-1 text-xs text-ink-subtle">The address and unsubscribe line are required on marketing email and added for you.</p>}
      </aside>
    </div>
  );
}

function Choice({
  legend,
  value,
  options,
  onChange,
  disabled,
}: {
  legend: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg border border-line-strong p-1">
        {options.map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={`min-h-9 rounded-md text-sm disabled:opacity-60 ${value === v ? "bg-brand-soft font-medium text-brand" : "text-ink-muted"}`}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
