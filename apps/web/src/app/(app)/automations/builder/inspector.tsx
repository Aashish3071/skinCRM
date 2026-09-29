"use client";

import { useRef, useState } from "react";
import { isValidEmail,
  AUTOMATION_STOP_CONDITIONS,
  AUTOMATION_TRIGGERS,
  FILTER_CONDITIONS,
  FILTER_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  NOTIFY_AUDIENCES,
  NOTIFY_AUDIENCE_LABELS,
  STOP_CONDITION_LABELS,
  TASK_PRIORITIES,
  TRIGGER_LABELS,
  WAIT_UNITS,
  type AutomationStep,
  type AutomationStopCondition,
  type AutomationTrigger,
  type AutomationTriggerConfig,
  type LeadSource,
  type StageCategory,
} from "@skincrm/contracts";
import { inputClasses } from "@/components/ui";
import { DUE_PRESETS, type CanvasOptions } from "./model";

/**
 * The settings panel for whichever card is selected on the canvas. Every
 * control is a plain labelled form element — the canvas is a picture of the
 * automation, but editing it never requires anything more than a form.
 */

const labelClass = "block text-sm font-medium";
const hintClass = "mt-1 text-xs text-ink-subtle";

export function TriggerInspector({
  trigger,
  options,
  onChange,
}: {
  trigger: AutomationTriggerConfig;
  options: CanvasOptions;
  onChange: (trigger: AutomationTriggerConfig) => void;
}) {
  const choose = (type: AutomationTrigger) => {
    if (type === trigger.type) return;
    switch (type) {
      case "lead_created":
        return onChange({ type, sources: [] });
      case "stage_changed":
        return onChange({ type, stageCategory: options.stages[1]?.category ?? "connected" });
      case "appointment_upcoming":
        return onChange({ type, hoursBefore: 24 });
      default:
        return onChange({ type });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className={labelClass}>Start this automation when…</legend>
        <div className="mt-2 flex flex-col gap-1.5">
          {AUTOMATION_TRIGGERS.map((type) => (
            <label
              key={type}
              className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 ${
                trigger.type === type ? "border-brand bg-brand-soft" : "border-line hover:bg-surface-muted"
              }`}
            >
              <input type="radio" name="trigger" checked={trigger.type === type} onChange={() => choose(type)} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">{TRIGGER_LABELS[type].title}</span>
                <span className="block text-xs text-ink-muted">{TRIGGER_LABELS[type].description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {trigger.type === "lead_created" && (
        <ChipPicker
          legend="Only leads from"
          hint="Leave all off for every source."
          values={LEAD_SOURCES}
          selected={trigger.sources}
          label={(s) => LEAD_SOURCE_LABELS[s]}
          onChange={(sources) => onChange({ ...trigger, sources })}
        />
      )}

      {trigger.type === "stage_changed" && (
        <div>
          <label htmlFor="trigger-stage" className={labelClass}>
            Stage
          </label>
          <select
            id="trigger-stage"
            value={trigger.stageCategory}
            onChange={(e) => onChange({ ...trigger, stageCategory: e.target.value as StageCategory })}
            className={`${inputClasses} mt-1.5`}
          >
            {options.stages.map((s) => (
              <option key={s.category} value={s.category}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {trigger.type === "appointment_upcoming" && (
        <div>
          <label htmlFor="hours-before" className={labelClass}>
            How long before
          </label>
          <select
            id="hours-before"
            value={trigger.hoursBefore}
            onChange={(e) => onChange({ ...trigger, hoursBefore: Number(e.target.value) })}
            className={`${inputClasses} mt-1.5`}
          >
            {[1, 2, 3, 6, 12, 24, 48, 72, 168].map((h) => (
              <option key={h} value={h}>
                {h < 24 ? `${h} ${h === 1 ? "hour" : "hours"}` : `${h / 24} ${h === 24 ? "day" : "days"}`}
              </option>
            ))}
          </select>
          <p className={hintClass}>Booked at shorter notice? It goes out straight away instead.</p>
        </div>
      )}
    </div>
  );
}

export function StepInspector({
  step,
  options,
  onChange,
}: {
  step: AutomationStep;
  options: CanvasOptions;
  onChange: (step: AutomationStep) => void;
}) {
  switch (step.type) {
    case "wait":
      return (
        <div className="flex flex-col gap-2">
          <span className={labelClass} id={`${step.id}-wait`}>
            Wait for
          </span>
          <div className="flex gap-2" role="group" aria-labelledby={`${step.id}-wait`}>
            <label className="sr-only" htmlFor={`${step.id}-amount`}>
              Amount
            </label>
            <input
              id={`${step.id}-amount`}
              type="number"
              min={1}
              max={365}
              value={step.amount}
              onChange={(e) => onChange({ ...step, amount: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
              className={`${inputClasses} w-24`}
            />
            <label className="sr-only" htmlFor={`${step.id}-unit`}>
              Unit
            </label>
            <select
              id={`${step.id}-unit`}
              value={step.unit}
              onChange={(e) => onChange({ ...step, unit: e.target.value as (typeof WAIT_UNITS)[number] })}
              className={inputClasses}
            >
              {WAIT_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <p className={hintClass}>Messages due during quiet hours wait until quiet hours end.</p>
        </div>
      );

    case "send_email":
    case "send_whatsapp":
      return <MessageInspector step={step} options={options} onChange={onChange} />;

    case "create_task":
      return (
        <div className="flex flex-col gap-4">
          <div>
            <label htmlFor={`${step.id}-title`} className={labelClass}>
              Task
            </label>
            <input
              id={`${step.id}-title`}
              value={step.title}
              maxLength={200}
              onChange={(e) => onChange({ ...step, title: e.target.value })}
              className={`${inputClasses} mt-1.5`}
            />
            <p className={hintClass}>Given to the lead&rsquo;s owner, or the shared queue if nobody owns it.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${step.id}-due`} className={labelClass}>
                Due
              </label>
              <select
                id={`${step.id}-due`}
                value={step.dueInHours}
                onChange={(e) => onChange({ ...step, dueInHours: Number(e.target.value) })}
                className={`${inputClasses} mt-1.5`}
              >
                {DUE_PRESETS.map((p) => (
                  <option key={p.hours} value={p.hours}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${step.id}-priority`} className={labelClass}>
                Priority
              </label>
              <select
                id={`${step.id}-priority`}
                value={step.priority}
                onChange={(e) => onChange({ ...step, priority: e.target.value as (typeof TASK_PRIORITIES)[number] })}
                className={`${inputClasses} mt-1.5 capitalize`}
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      );

    case "move_stage":
      return (
        <div>
          <label htmlFor={`${step.id}-stage`} className={labelClass}>
            Move the lead to
          </label>
          <select
            id={`${step.id}-stage`}
            value={step.stageCategory}
            onChange={(e) => onChange({ ...step, stageCategory: e.target.value as StageCategory })}
            className={`${inputClasses} mt-1.5`}
          >
            {options.stages.map((s) => (
              <option key={s.category} value={s.category}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      );

    case "notify_team":
      return <NotifyInspector step={step} options={options} onChange={onChange} />;

    case "filter":
      return (
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className={labelClass}>Only continue if…</legend>
            <div className="mt-2 flex flex-col gap-1.5">
              {FILTER_CONDITIONS.map((c) => (
                <label key={c} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input type="radio" name={`${step.id}-condition`} checked={step.condition === c} onChange={() => onChange({ ...step, condition: c })} />
                  {FILTER_LABELS[c]}
                </label>
              ))}
            </div>
            <p className={hintClass}>If it isn&rsquo;t true, the automation stops here for that person.</p>
          </fieldset>
          {step.condition === "stage_is" && (
            <ChipPicker
              legend="Stages"
              values={options.stages.map((s) => s.category)}
              selected={step.stageCategories}
              label={(c) => options.stages.find((s) => s.category === c)?.name ?? c}
              onChange={(stageCategories) => onChange({ ...step, stageCategories })}
            />
          )}
          {step.condition === "source_is" && (
            <ChipPicker
              legend="Sources"
              values={LEAD_SOURCES}
              selected={step.sources}
              label={(s: LeadSource) => LEAD_SOURCE_LABELS[s]}
              onChange={(sources) => onChange({ ...step, sources })}
            />
          )}
        </div>
      );
  }
}

function MessageInspector({
  step,
  options,
  onChange,
}: {
  step: Extract<AutomationStep, { type: "send_email" | "send_whatsapp" }>;
  options: CanvasOptions;
  onChange: (step: AutomationStep) => void;
}) {
  const channel = step.type === "send_email" ? "email" : "whatsapp";
  const templates = options.templates.filter((t) => t.channel === channel);
  const usingTemplate = step.templateKey !== null && step.templateKey !== undefined;
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (name: string) => {
    const token = `{{${name}}}`;
    const el = bodyRef.current;
    const body = step.body ?? "";
    if (!el) return onChange({ ...step, body: body + token });
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    onChange({ ...step, body: body.slice(0, start) + token + body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className={labelClass}>What kind of message is this?</legend>
        <div className="mt-2 grid gap-1.5">
          {(
            [
              ["operational", "Service message", "Confirmations, reminders, replies to their inquiry."],
              ["promotional", "Marketing", "Offers and follow-ups. Only sent to people who agreed to marketing."],
            ] as const
          ).map(([value, title, description]) => (
            <label
              key={value}
              className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 ${
                step.purpose === value ? "border-brand bg-brand-soft" : "border-line hover:bg-surface-muted"
              }`}
            >
              <input type="radio" name={`${step.id}-purpose`} checked={step.purpose === value} onChange={() => onChange({ ...step, purpose: value })} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-xs text-ink-muted">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {templates.length > 0 && (
        <div role="group" aria-label="Message source" className="inline-flex self-start rounded-lg border border-line-strong p-0.5">
          {(
            [
              [false, "Write it here"],
              [true, "Use a saved template"],
            ] as const
          ).map(([template, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={usingTemplate === template}
              onClick={() => onChange({ ...step, templateKey: template ? templates[0]!.key : null })}
              className={`min-h-8 rounded-md px-3 text-[13px] ${
                usingTemplate === template ? "bg-brand-soft font-medium text-brand" : "text-ink-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {usingTemplate ? (
        <div>
          <label htmlFor={`${step.id}-template`} className={labelClass}>
            Template
          </label>
          <select
            id={`${step.id}-template`}
            value={step.templateKey ?? ""}
            onChange={(e) => onChange({ ...step, templateKey: e.target.value })}
            className={`${inputClasses} mt-1.5`}
          >
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
                {t.channel === "whatsapp" && t.whatsappTemplateName ? ` (${t.whatsappStatus ?? "draft"})` : ""}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          {step.type === "send_email" && (
            <div>
              <label htmlFor={`${step.id}-subject`} className={labelClass}>
                Subject
              </label>
              <input
                id={`${step.id}-subject`}
                value={step.subject ?? ""}
                maxLength={200}
                onChange={(e) => onChange({ ...step, subject: e.target.value })}
                className={`${inputClasses} mt-1.5`}
              />
              <p className={hintClass}>Keep it general — no treatments or conditions in a subject line.</p>
            </div>
          )}
          <div>
            <label htmlFor={`${step.id}-body`} className={labelClass}>
              Message
            </label>
            <textarea
              ref={bodyRef}
              id={`${step.id}-body`}
              value={step.body ?? ""}
              rows={8}
              onChange={(e) => onChange({ ...step, body: e.target.value })}
              className={`${inputClasses} mt-1.5 font-[inherit] leading-relaxed`}
            />
            <div className="mt-2">
              <p className="text-xs text-ink-subtle">Insert:</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {options.variables
                  .filter((v) => v.name !== "link.unsubscribe" && v.name !== "link.reschedule")
                  .map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      title={v.description}
                      onClick={() => insertVariable(v.name)}
                      className="rounded-md border border-line bg-surface-muted px-2 py-1 text-xs text-ink-muted hover:border-line-strong hover:text-ink"
                    >
                      {friendlyVariable(v.name)}
                    </button>
                  ))}
              </div>
            </div>
            {step.type === "send_email" && step.purpose === "promotional" && (
              <p className={hintClass}>Your clinic&rsquo;s address and an unsubscribe link are added at the bottom automatically.</p>
            )}
          </div>
        </>
      )}

      {step.type === "send_whatsapp" && !templateIsApprovedWhatsApp(step.templateKey, options) && (
        <p className="rounded-lg bg-caution-soft px-3 py-2 text-xs text-caution">
          WhatsApp only delivers written messages to people who messaged you in the last 24 hours. For reminders to
          everyone, use a template approved by Meta.
        </p>
      )}
    </div>
  );
}

function NotifyInspector({
  step,
  options,
  onChange,
}: {
  step: Extract<AutomationStep, { type: "notify_team" }>;
  options: CanvasOptions;
  onChange: (step: AutomationStep) => void;
}) {
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const addEmail = () => {
    const email = draft.trim().toLowerCase();
    if (!email) return;
    if (!isValidEmail(email)) return setBad(true);
    if (!step.extraEmails.includes(email)) onChange({ ...step, extraEmails: [...step.extraEmails, email] });
    setDraft("");
    setBad(false);
  };
  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className={labelClass}>Who gets the email?</legend>
        <div className="mt-2 flex flex-col gap-2">
          {NOTIFY_AUDIENCES.map((a) => (
            <label key={a} className="flex cursor-pointer items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={step.audiences.includes(a)}
                onChange={(e) => onChange({ ...step, audiences: e.target.checked ? [...step.audiences, a] : step.audiences.filter((x) => x !== a) })}
              />
              {NOTIFY_AUDIENCE_LABELS[a]}
            </label>
          ))}
        </div>
      </fieldset>
      {options.staff.length > 0 && (
        <ChipPicker
          legend="And these people"
          values={options.staff.map((s) => s.id)}
          selected={step.userIds}
          label={(id) => options.staff.find((s) => s.id === id)?.name ?? id}
          onChange={(userIds) => onChange({ ...step, userIds })}
        />
      )}
      <div>
        <label htmlFor={`${step.id}-extra`} className={labelClass}>Other email addresses</label>
        <p className={hintClass}>For example a manager&rsquo;s personal address while travelling.</p>
        <div className="mt-1.5 flex gap-2">
          <input
            id={`${step.id}-extra`}
            type="email"
            value={draft}
            aria-invalid={bad}
            onChange={(e) => { setDraft(e.target.value); setBad(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
            placeholder="name@example.com"
            className={inputClasses}
          />
          <button type="button" onClick={addEmail} className="shrink-0 rounded-lg border border-line-strong px-3 text-sm hover:bg-surface-muted">Add</button>
        </div>
        {bad && <p role="alert" className="mt-1 text-xs text-critical">That doesn&rsquo;t look like an email address.</p>}
        {step.extraEmails.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {step.extraEmails.map((e) => (
              <li key={e} className="inline-flex items-center gap-1 rounded-full bg-surface-muted py-1 pl-3 pr-1 text-xs">
                {e}
                <button type="button" aria-label={`Remove ${e}`} onClick={() => onChange({ ...step, extraEmails: step.extraEmails.filter((x) => x !== e) })} className="rounded-full px-1.5 hover:bg-line">×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" checked={step.includeContact} onChange={(e) => onChange({ ...step, includeContact: e.target.checked })} className="mt-0.5" />
        <span>
          Include their phone and email
          <span className={`${hintClass} block`}>Untick to send only the name and a link that needs a sign-in to open.</span>
        </span>
      </label>
    </div>
  );
}

function templateIsApprovedWhatsApp(key: string | null | undefined, options: CanvasOptions): boolean {
  const t = key ? options.templates.find((x) => x.key === key) : undefined;
  return Boolean(t?.whatsappTemplateName && t.whatsappStatus === "approved");
}

const FRIENDLY: Record<string, string> = {
  "person.firstName": "First name",
  "person.fullName": "Full name",
  "clinic.name": "Clinic name",
  "clinic.phone": "Clinic contact",
  "clinic.address": "Clinic address",
  "appointment.date": "Appointment date",
  "appointment.time": "Appointment time",
  "appointment.staffName": "Who they're seeing",
};

export function friendlyVariable(name: string): string {
  return FRIENDLY[name] ?? name;
}

export function StopInspector({
  stopWhen,
  onChange,
}: {
  stopWhen: AutomationStopCondition[];
  onChange: (stopWhen: AutomationStopCondition[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className={labelClass}>Stop early for someone if…</legend>
      {AUTOMATION_STOP_CONDITIONS.map((c) => (
        <label key={c} className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={stopWhen.includes(c)}
            onChange={(e) => onChange(e.target.checked ? [...stopWhen, c] : stopWhen.filter((x) => x !== c))}
          />
          {STOP_CONDITION_LABELS[c]}
        </label>
      ))}
      <p className={hintClass}>
        Opted-out contacts are always skipped, and appointment messages stop by themselves if the appointment is
        cancelled or moved.
      </p>
    </fieldset>
  );
}

function ChipPicker<T extends string>({
  legend,
  hint,
  values,
  selected,
  label,
  onChange,
}: {
  legend: string;
  hint?: string;
  values: readonly T[];
  selected: T[];
  label: (value: T) => string;
  onChange: (next: T[]) => void;
}) {
  return (
    <fieldset>
      <legend className={labelClass}>{legend}</legend>
      {hint && <p className={hintClass}>{hint}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {values.map((value) => {
          const on = selected.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((v) => v !== value) : [...selected, value])}
              className={`min-h-8 rounded-full border px-3 text-xs ${
                on ? "border-brand bg-brand-soft font-medium text-brand" : "border-line-strong text-ink-muted hover:bg-surface-muted"
              }`}
            >
              {label(value)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

