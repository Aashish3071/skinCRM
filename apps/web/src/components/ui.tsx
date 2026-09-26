import type { ReactNode } from "react";

/**
 * Small set of shared primitives. Deliberately plain: a CRM lives or dies on
 * legible density and keyboard flow, not on component-library surface area.
 */

export function Card({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-line bg-surface">
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

type Tone = "neutral" | "brand" | "positive" | "caution" | "critical";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-surface-muted text-ink-muted",
  brand: "bg-brand-soft text-brand",
  positive: "bg-positive-soft text-positive",
  caution: "bg-caution-soft text-caution",
  critical: "bg-critical-soft text-critical",
};

/**
 * Status pill. The label always carries the meaning; colour is only reinforcement,
 * so the UI stays readable for colour-blind users and in greyscale print.
 */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  errors,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  errors?: string[];
  children: ReactNode;
}) {
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-ink-subtle">
          {hint}
        </p>
      )}
      <div className="mt-1.5">{children}</div>
      {errors && errors.length > 0 && (
        // Announced to screen readers as soon as it appears.
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-critical">
          {errors.join(". ")}
        </p>
      )}
    </div>
  );
}

export const inputClasses =
  "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm " +
  "placeholder:text-ink-subtle disabled:opacity-60";

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-line-strong px-5 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-muted">{children}</div>}
    </div>
  );
}

/**
 * Honest placeholder for a section that is planned but not built. Names the PRD
 * requirements it will satisfy, so the nav can be complete without implying the
 * feature exists.
 */
export function NotBuiltYet({
  phase,
  requirements,
  summary,
}: {
  phase: string;
  requirements: string[];
  summary: string;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Badge tone="caution">Not built yet — {phase}</Badge>
        <p className="text-sm text-ink-muted">{summary}</p>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
            Planned requirements
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {requirements.map((id) => (
              <li
                key={id}
                className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-ink-muted"
              >
                {id}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
