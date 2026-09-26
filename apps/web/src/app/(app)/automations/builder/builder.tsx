"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  STEP_LABELS,
  STOP_CONDITION_LABELS,
  TRIGGER_LABELS,
  saveAutomationSchema,
  type AutomationStatus,
  type AutomationStep,
  type AutomationStepType,
  type TestRunLine,
} from "@skincrm/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlayIcon, PlusIcon, SparkIcon, TrashIcon, XIcon, ZapIcon } from "@/components/icons";
import { Badge, buttonClasses } from "@/components/ui";
import {
  deleteAutomationAction,
  saveAutomationAction,
  setAutomationStatusAction,
  testAutomationAction,
} from "@/lib/automation-actions";
import { StepInspector, StopInspector, TriggerInspector } from "./inspector";
import {
  STEP_ICONS,
  STEP_MENU,
  defaultStep,
  errorsByNode,
  stepSummary,
  triggerSummary,
  type CanvasOptions,
  type Draft,
} from "./model";

type Selection = "trigger" | "end" | string;

/**
 * The automation canvas.
 *
 * Left: the flow, top to bottom — trigger, steps, end — with a "+" between
 * every pair to insert a step. Right: settings for the selected card. On a
 * phone the settings panel opens as a sheet over the flow.
 *
 * The flow is a picture of an ordered list, not a free-form graph, so it can
 * be read aloud in order and edited with a keyboard: every card is a button,
 * and steps move with up/down buttons rather than only by dragging.
 */
export function AutomationBuilder({
  id,
  initial,
  status: initialStatus,
  options,
}: {
  id: string | null;
  initial: Draft;
  status: AutomationStatus;
  options: CanvasOptions;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initial);
  const [status, setStatus] = useState<AutomationStatus>(initialStatus);
  const [selected, setSelected] = useState<Selection | null>("trigger");
  const [menuAt, setMenuAt] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [dirty, setDirty] = useState(id === null);
  const [pending, startTransition] = useTransition();
  const [test, setTest] = useState<{ personName: string; lines: TestRunLine[] } | null>(null);

  // On a phone the settings panel is a sheet over the flow; start with it
  // closed so the flow is what people see first.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1023px)").matches) setSelected(null);
  }, []);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const update = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setDirty(true);
    setBanner(null);
  };
  const updateStep = (step: AutomationStep) =>
    update({ steps: draft.steps.map((s) => (s.id === step.id ? step : s)) });

  const insertStep = (index: number, type: AutomationStepType) => {
    const step = defaultStep(type, options.stages);
    const steps = [...draft.steps];
    steps.splice(index, 0, step);
    update({ steps });
    setSelected(step.id);
    setMenuAt(null);
  };
  const removeStep = (stepId: string) => {
    update({ steps: draft.steps.filter((s) => s.id !== stepId) });
    setSelected(null);
  };
  const moveStep = (stepId: string, delta: -1 | 1) => {
    const index = draft.steps.findIndex((s) => s.id === stepId);
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    update({ steps });
  };

  /** Client-side check first: instant, and it points at the card to fix. */
  const validate = (): boolean => {
    const parsed = saveAutomationSchema.safeParse(draft);
    if (parsed.success) {
      setErrors({});
      return true;
    }
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      (details[key] ??= []).push(issue.message);
    }
    const byNode = errorsByNode(details, draft.steps);
    setErrors(byNode);
    const first = Object.keys(byNode)[0];
    if (first && first !== "general" && first !== "name") setSelected(first);
    setBanner({ tone: "error", text: "A few things need fixing — they're marked in red." });
    return false;
  };

  const save = () => {
    if (!validate()) return;
    startTransition(async () => {
      const result = await saveAutomationAction(id, saveAutomationSchema.parse(draft));
      if (result.status === "error") {
        setErrors(errorsByNode(result.fieldErrors, draft.steps));
        setBanner({ tone: "error", text: result.message });
        return;
      }
      setDirty(false);
      setBanner({ tone: "ok", text: id ? "Saved." : "Saved. Switch it on when you're ready." });
      if (!id) router.replace(`/automations/${result.automation.id}`);
      else router.refresh();
    });
  };

  const toggle = () => {
    if (!id) return;
    if (dirty) {
      setBanner({ tone: "error", text: "Save your changes first." });
      return;
    }
    const next: AutomationStatus = status === "active" ? "paused" : "active";
    if (next === "paused" && !window.confirm("Pause this automation? Anyone currently in it will be stopped.")) return;
    startTransition(async () => {
      const result = await setAutomationStatusAction(id, next);
      if (result.status === "error") return setBanner({ tone: "error", text: result.message });
      setStatus(result.automation.status);
      setBanner({ tone: "ok", text: next === "active" ? "It's on. New matches will start from now." : "Paused." });
      router.refresh();
    });
  };

  const runTest = () => {
    if (!validate()) return;
    startTransition(async () => {
      const result = await testAutomationAction(saveAutomationSchema.parse(draft));
      if (result.status === "error") {
        setErrors(errorsByNode(result.fieldErrors, draft.steps));
        return setBanner({ tone: "error", text: result.message });
      }
      setTest({ personName: result.lead.personName, lines: result.lines });
    });
  };

  const remove = () => {
    if (!id || !window.confirm("Delete this automation? Anyone in it will be stopped. This can't be undone.")) return;
    startTransition(async () => {
      const result = await deleteAutomationAction(id);
      if (result.status === "error") return setBanner({ tone: "error", text: result.message });
      setDirty(false);
      router.push("/automations");
    });
  };

  const selectedStep = draft.steps.find((s) => s.id === selected);

  return (
    <div className="flex flex-col gap-4">
      {/* --- Top bar ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/automations" className="text-sm text-ink-muted hover:text-ink">
          ← Automations
        </Link>
        <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-64">
          <label htmlFor="automation-name" className="sr-only">
            Automation name
          </label>
          <input
            id="automation-name"
            value={draft.name}
            maxLength={120}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="Name this automation"
            aria-invalid={Boolean(errors.name)}
            className={`min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-xl font-semibold tracking-tight hover:border-line-strong focus:border-line-strong ${
              errors.name ? "border-critical" : "border-transparent"
            }`}
          />
          {id && (
            <Badge tone={status === "active" ? "positive" : "neutral"}>{status === "active" ? "On" : "Off"}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={runTest} disabled={pending} className={buttonClasses("secondary")}>
            <SparkIcon size={16} /> Test
          </button>
          {id && (
            <button type="button" onClick={toggle} disabled={pending} className={buttonClasses("secondary")}>
              {status === "active" ? "Turn off" : (
                <>
                  <PlayIcon size={14} /> Turn on
                </>
              )}
            </button>
          )}
          <button type="button" onClick={save} disabled={pending || !dirty} className={buttonClasses("primary")}>
            {pending ? "Working…" : dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>

      {banner && (
        <p
          role={banner.tone === "error" ? "alert" : "status"}
          className={`rounded-lg px-3 py-2 text-sm ${
            banner.tone === "error" ? "bg-critical-soft text-critical" : "bg-positive-soft text-positive"
          }`}
        >
          {banner.text}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* --- Canvas ----------------------------------------------------- */}
        <section
          aria-label="Automation flow"
          className="min-w-0 rounded-card border border-line bg-surface-muted px-3 py-6 sm:px-4 sm:py-8 [background-image:radial-gradient(var(--color-line-strong)_1px,transparent_1px)] [background-size:18px_18px]"
        >
          <ol className="mx-auto flex max-w-md flex-col items-stretch">
            <li>
              <Node
                kind="When"
                icon={ZapIcon}
                title={TRIGGER_LABELS[draft.trigger.type].title}
                summary={triggerSummary(draft.trigger, options.stages)}
                selected={selected === "trigger"}
                errors={errors.trigger}
                onSelect={() => setSelected("trigger")}
                accent
              />
            </li>

            {draft.steps.map((step, index) => {
              const Icon = STEP_ICONS[step.type];
              return (
                <li key={step.id}>
                  <Connector
                    open={menuAt === index}
                    onToggle={() => setMenuAt(menuAt === index ? null : index)}
                    onPick={(type) => insertStep(index, type)}
                  />
                  <Node
                    kind={`Step ${index + 1}`}
                    icon={Icon}
                    title={STEP_LABELS[step.type].title}
                    summary={stepSummary(step, options)}
                    selected={selected === step.id}
                    errors={errors[step.id]}
                    onSelect={() => setSelected(step.id)}
                    tools={
                      <>
                        <IconButton label="Move up" disabled={index === 0} onClick={() => moveStep(step.id, -1)}>
                          <ArrowUpIcon size={15} />
                        </IconButton>
                        <IconButton label="Move down" disabled={index === draft.steps.length - 1} onClick={() => moveStep(step.id, 1)}>
                          <ArrowDownIcon size={15} />
                        </IconButton>
                        <IconButton label="Delete step" onClick={() => removeStep(step.id)}>
                          <TrashIcon size={15} />
                        </IconButton>
                      </>
                    }
                  />
                </li>
              );
            })}

            <li>
              <Connector
                open={menuAt === draft.steps.length}
                onToggle={() => setMenuAt(menuAt === draft.steps.length ? null : draft.steps.length)}
                onPick={(type) => insertStep(draft.steps.length, type)}
                prominent={draft.steps.length === 0}
              />
              <button
                type="button"
                onClick={() => setSelected("end")}
                aria-pressed={selected === "end"}
                className={`w-full rounded-full border px-4 py-2 text-center text-sm ${
                  selected === "end" ? "border-brand bg-surface text-brand" : "border-line-strong bg-surface text-ink-muted hover:text-ink"
                }`}
              >
                End
                {draft.stopWhen.length > 0 && (
                  <span className="block text-xs text-ink-subtle">
                    or earlier if {draft.stopWhen.map((c) => STOP_CONDITION_LABELS[c].toLowerCase()).join(", ")}
                  </span>
                )}
              </button>
            </li>
          </ol>
          {errors.general && (
            <p role="alert" className="mx-auto mt-4 max-w-md text-center text-sm text-critical">
              {errors.general.join(". ")}
            </p>
          )}
        </section>

        {/* --- Settings panel -------------------------------------------- */}
        <aside
          aria-label="Settings"
          className={`${
            selected ? "fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-2xl pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-pop)]" : "hidden"
          } border border-line bg-surface p-5 lg:sticky lg:top-6 lg:z-auto lg:block lg:max-h-[calc(100vh-3rem)] lg:self-start lg:rounded-card lg:shadow-none`}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">
              {selected === "trigger"
                ? "Trigger"
                : selected === "end"
                  ? "Stopping early"
                  : selectedStep
                    ? STEP_LABELS[selectedStep.type].title
                    : "Settings"}
            </h2>
            <button type="button" onClick={() => setSelected(null)} aria-label="Close settings" className="rounded-md p-1.5 text-ink-muted hover:bg-surface-muted lg:hidden">
              <XIcon size={16} />
            </button>
          </div>
          {selected && errors[selected] && (
            <ul role="alert" className="mb-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
              {errors[selected]!.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {selected === "trigger" && (
            <TriggerInspector trigger={draft.trigger} options={options} onChange={(trigger) => update({ trigger })} />
          )}
          {selected === "end" && <StopInspector stopWhen={draft.stopWhen} onChange={(stopWhen) => update({ stopWhen })} />}
          {selectedStep && <StepInspector step={selectedStep} options={options} onChange={updateStep} />}
          {!selected && <p className="text-sm text-ink-muted">Select a card on the left to change it.</p>}
        </aside>
      </div>

      {id && (
        <div className="flex justify-end">
          <button type="button" onClick={remove} disabled={pending} className={buttonClasses("danger", "sm")}>
            <TrashIcon size={14} /> Delete automation
          </button>
        </div>
      )}

      {test && <TestResults personName={test.personName} lines={test.lines} onClose={() => setTest(null)} />}
    </div>
  );
}

function Node({
  kind,
  icon: Icon,
  title,
  summary,
  selected,
  errors,
  onSelect,
  tools,
  accent = false,
}: {
  kind: string;
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  summary: string;
  selected: boolean;
  errors?: string[];
  onSelect: () => void;
  tools?: React.ReactNode;
  accent?: boolean;
}) {
  const invalid = Boolean(errors?.length);
  return (
    <div
      className={`group relative rounded-card border bg-surface shadow-[var(--shadow-card)] transition-shadow ${
        invalid ? "border-critical" : selected ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-strong"
      }`}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} className="flex w-full items-start gap-3 p-4 text-left">
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            accent ? "bg-brand text-on-brand" : "bg-brand-soft text-brand"
          }`}
        >
          <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{kind}</span>
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block truncate text-sm text-ink-muted">{summary}</span>
          {invalid && <span className="mt-1 block text-xs text-critical">Needs attention</span>}
        </span>
      </button>
      {tools && (
        <div
          className={`absolute right-2 top-2 flex gap-0.5 rounded-lg bg-surface ${
            selected ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
          }`}
        >
          {tools}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** The line between two cards, with the "+" that inserts a step there. */
function Connector({
  open,
  onToggle,
  onPick,
  prominent = false,
}: {
  open: boolean;
  onToggle: () => void;
  onPick: (type: AutomationStepType) => void;
  prominent?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && onToggle();
    window.addEventListener("keydown", close);
    menuRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    menuRef.current?.querySelector("button")?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", close);
  }, [open, onToggle]);

  return (
    <div className="relative flex flex-col items-center py-1">
      <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label="Add a step here"
        className={`flex items-center justify-center gap-1.5 rounded-full border bg-surface text-ink-muted transition-colors hover:border-brand hover:text-brand ${
          prominent ? "min-h-10 px-4 text-sm font-medium" : "h-7 w-7"
        } ${open ? "border-brand text-brand" : "border-line-strong"}`}
      >
        <PlusIcon size={prominent ? 16 : 14} />
        {prominent && "Add a step"}
      </button>
      <span aria-hidden="true" className="h-4 w-px bg-line-strong" />

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute top-full z-20 mt-[-12px] w-72 rounded-card border border-line bg-surface p-1.5 shadow-[var(--shadow-pop)]"
        >
          {STEP_MENU.map((type) => {
            const Icon = STEP_ICONS[type];
            return (
              <button
                key={type}
                type="button"
                role="menuitem"
                onClick={() => onPick(type)}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-surface-muted focus:bg-surface-muted"
              >
                <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <Icon size={16} />
                </span>
                <span>
                  <span className="block text-sm font-medium">{STEP_LABELS[type].title}</span>
                  <span className="block text-xs text-ink-muted">{STEP_LABELS[type].description}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const OUTCOME_BADGE: Record<TestRunLine["outcome"], { tone: "positive" | "critical" | "neutral" | "caution"; label: string }> = {
  would_run: { tone: "positive", label: "Would run" },
  would_block: { tone: "critical", label: "Would be blocked" },
  would_stop: { tone: "caution", label: "Would stop" },
  info: { tone: "neutral", label: "" },
};

function TestResults({
  personName,
  lines,
  onClose,
}: {
  personName: string;
  lines: TestRunLine[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(640px,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-[var(--shadow-pop)] backdrop:bg-black/30"
    >
      <div className="flex items-start justify-between gap-3 border-b border-line p-5">
        <div>
          <h2 className="text-base font-semibold">Test run for {personName}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">What would happen right now. Nothing was sent.</p>
        </div>
        <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-md p-1.5 text-ink-muted hover:bg-surface-muted">
          <XIcon size={16} />
        </button>
      </div>
      <ol className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto p-5">
        {lines.map((line) => {
          const badge = OUTCOME_BADGE[line.outcome];
          return (
            <li key={line.stepIndex} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {line.stepIndex + 1}. {line.summary}
                </p>
                {badge.label && <Badge tone={badge.tone}>{badge.label}</Badge>}
              </div>
              {line.detail && <p className="mt-1 text-sm text-ink-muted">{line.detail}</p>}
              {line.preview && (
                <div className="mt-2 rounded-md bg-surface-muted p-3 text-sm">
                  {line.preview.subject && <p className="mb-2 font-medium">{line.preview.subject}</p>}
                  <p className="whitespace-pre-wrap text-ink-muted">{line.preview.body}</p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </dialog>
  );
}
