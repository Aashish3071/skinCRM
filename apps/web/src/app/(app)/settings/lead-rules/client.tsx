"use client";

import { useRef, useState, useTransition } from "react";
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  SLA_MINUTE_CHOICES,
  type AssignmentRuleDto,
  type LeadRulesSettings,
  type LeadSource,
} from "@skincrm/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "@/components/icons";
import { Badge, Field, buttonClasses, inputClasses } from "@/components/ui";
import {
  deleteRuleAction,
  previewRuleAction,
  reorderRulesAction,
  saveRuleAction,
  saveSlaAction,
  toggleRuleAction,
  type RuleResult,
} from "@/lib/rules-actions";

type Staff = { id: string; fullName: string };
type Branch = { id: string; name: string };

function minutesLabel(m: number): string {
  if (m === 0) return "No target";
  if (m < 60) return `${m} minutes`;
  if (m < 1440) return `${m / 60} ${m === 60 ? "hour" : "hours"}`;
  return "1 day";
}

function Outcome({ result }: { result: RuleResult | null }) {
  if (!result) return null;
  return result.ok ? (
    result.detail ? <p role="status" className="text-sm text-positive">{result.detail}</p> : null
  ) : (
    <p role="alert" className="text-sm text-critical">{result.message}</p>
  );
}

function Section({ title, intro, children, action }: { title: string; intro: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 max-w-2xl text-sm text-ink-muted">{intro}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function SlaCard({ initial, writable }: { initial: LeadRulesSettings; writable: boolean }) {
  const [minutes, setMinutes] = useState(initial.firstResponseSlaMinutes);
  const [escalate, setEscalate] = useState(initial.slaEscalationEnabled);
  const [result, setResult] = useState<RuleResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <Section title="Response time" intro="How quickly someone should respond to a new lead. A call attempt, a message, or moving the lead on all count as a response.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); start(async () => setResult(await saveSlaAction({ firstResponseSlaMinutes: minutes, slaEscalationEnabled: escalate }))); }}>
        <fieldset disabled={!writable}>
          <legend className="text-sm font-medium">Respond to every new lead within</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {SLA_MINUTE_CHOICES.map((m) => (
              <button key={m} type="button" aria-pressed={minutes === m} onClick={() => setMinutes(m)}
                className={`min-h-10 rounded-full border px-4 text-sm ${minutes === m ? "border-brand bg-brand-soft font-medium text-brand" : "border-line-strong text-ink-muted hover:bg-surface-muted"}`}>
                {minutesLabel(m)}
              </button>
            ))}
          </div>
        </fieldset>
        {minutes > 0 && (
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={escalate} disabled={!writable} onChange={(e) => setEscalate(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">If nobody responds in time, raise the alarm</span>
              <span className="block text-ink-muted">Adds an urgent task for the lead&rsquo;s owner and emails them and the admins.</span>
            </span>
          </label>
        )}
        <p className="text-sm text-ink-muted">Leads show a countdown on the Leads board, and turn red when the time is up.</p>
        {writable && <div><button disabled={pending} className={buttonClasses("primary")}>{pending ? "Saving…" : "Save"}</button></div>}
        <Outcome result={result} />
      </form>
    </Section>
  );
}

function describeRule(rule: AssignmentRuleDto, staff: Staff[], branches: Branch[]) {
  const name = (id: string | null) => staff.find((s) => s.id === id)?.fullName ?? "someone who has left";
  const when = [
    rule.matchSource ? `comes from ${LEAD_SOURCE_LABELS[rule.matchSource]}` : null,
    rule.matchServiceInterest ? `mentions “${rule.matchServiceInterest}”` : null,
    rule.matchBranchId ? `is for ${branches.find((b) => b.id === rule.matchBranchId)?.name ?? "a branch"}` : null,
  ].filter(Boolean);
  const then = rule.assignMode === "user" ? `give it to ${name(rule.assignUserId)}` : `take turns between ${rule.poolUserIds.map(name).join(", ")}`;
  return { when: when.length ? `When a lead ${when.join(" and ")}` : "Any lead", then };
}

export function AssignmentRules({ rules, staff, branches, writable }: { rules: AssignmentRuleDto[]; staff: Staff[]; branches: Branch[]; writable: boolean }) {
  const [editing, setEditing] = useState<AssignmentRuleDto | "new" | null>(null);
  const [result, setResult] = useState<RuleResult | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<RuleResult>) => start(async () => setResult(await fn()));
  const move = (index: number, delta: -1 | 1) => {
    const ids = rules.map((r) => r.id);
    const target = index + delta;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    act(() => reorderRulesAction(ids));
  };

  return (
    <Section
      title="Who gets new leads"
      intro="Rules are checked from the top. The first one that fits decides who owns the lead; if none fits, it waits in the Unassigned queue."
      action={writable ? <button type="button" onClick={() => setEditing("new")} className={buttonClasses("primary", "sm")}><PlusIcon size={14} /> Add rule</button> : null}
    >
      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong p-6 text-center text-sm text-ink-muted">
          No rules yet, so every new lead waits in the Unassigned queue for someone to pick it up.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rules.map((rule, i) => {
            const d = describeRule(rule, staff, branches);
            return (
              <li key={rule.id} className={`flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 ${rule.isActive ? "" : "opacity-60"}`}>
                <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-ink-muted">{i + 1}</span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="font-medium">{rule.name}</p>
                  <p className="text-sm text-ink-muted">{d.when} → {d.then}</p>
                  <p className="text-xs text-ink-subtle">{rule.matchCount ? `Used ${rule.matchCount} times` : "Not used yet"}</p>
                </div>
                {!rule.isActive && <Badge>Off</Badge>}
                {writable && (
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label={`Move ${rule.name} up`} disabled={pending || i === 0} onClick={() => move(i, -1)} className="rounded-md p-2 text-ink-muted hover:bg-surface-muted disabled:opacity-30"><ArrowUpIcon size={15} /></button>
                    <button type="button" aria-label={`Move ${rule.name} down`} disabled={pending || i === rules.length - 1} onClick={() => move(i, 1)} className="rounded-md p-2 text-ink-muted hover:bg-surface-muted disabled:opacity-30"><ArrowDownIcon size={15} /></button>
                    <button type="button" onClick={() => act(() => toggleRuleAction(rule.id, !rule.isActive))} disabled={pending} className={buttonClasses("ghost", "sm")}>{rule.isActive ? "Turn off" : "Turn on"}</button>
                    <button type="button" onClick={() => setEditing(rule)} className={buttonClasses("secondary", "sm")}>Edit</button>
                    <button type="button" aria-label={`Delete ${rule.name}`} onClick={() => { if (window.confirm(`Delete “${rule.name}”?`)) act(() => deleteRuleAction(rule.id)); }} className="rounded-md p-2 text-critical hover:bg-critical-soft"><TrashIcon size={15} /></button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div className="mt-3"><Outcome result={result} /></div>
      <TryIt />
      {editing && (
        <RuleDialog
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? null : editing}
          nextPriority={(Math.max(0, ...rules.map((r) => r.priority)) || 0) + 10}
          staff={staff}
          branches={branches}
          onClose={() => setEditing(null)}
          onSaved={(r) => { setResult(r); setEditing(null); }}
        />
      )}
    </Section>
  );
}

function TryIt() {
  const [source, setSource] = useState<LeadSource>("meta_lead_ad");
  const [service, setService] = useState("");
  const [result, setResult] = useState<RuleResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <details className="mt-4 rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">Try it: where would a lead go?</summary>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); start(async () => setResult(await previewRuleAction(source, service))); }}>
        <label className="text-sm">From<select value={source} onChange={(e) => setSource(e.target.value as LeadSource)} className={`${inputClasses} mt-1`}>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{LEAD_SOURCE_LABELS[s]}</option>)}</select></label>
        <label className="min-w-0 flex-1 text-sm">Asking about (optional)<input value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. laser" className={`${inputClasses} mt-1`} /></label>
        <button disabled={pending} className={buttonClasses("secondary")}>Check</button>
      </form>
      <div className="mt-2"><Outcome result={result} /></div>
    </details>
  );
}

function RuleDialog({ rule, nextPriority, staff, branches, onClose, onSaved }: {
  rule: AssignmentRuleDto | null; nextPriority: number; staff: Staff[]; branches: Branch[]; onClose: () => void; onSaved: (r: RuleResult) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"user" | "round_robin">(rule?.assignMode ?? "user");
  const [pool, setPool] = useState<string[]>(rule?.poolUserIds ?? []);
  const [error, setError] = useState<RuleResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <dialog ref={(el) => { ref.current = el; if (el && !el.open) el.showModal(); }} onClose={onClose}
      className="m-auto max-h-[92dvh] w-[min(560px,calc(100vw-1rem))] overflow-y-auto rounded-card border border-line bg-surface p-0 text-ink shadow-[var(--shadow-pop)] backdrop:bg-black/30">
      <form className="flex flex-col gap-4 p-5" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const r = await saveRuleAction(rule?.id ?? null, {
            name: String(f.get("name")),
            priority: rule?.priority ?? nextPriority,
            isActive: rule?.isActive ?? true,
            matchSource: (String(f.get("source")) || null) as LeadSource | null,
            matchServiceInterest: String(f.get("service") ?? "") || null,
            matchBranchId: String(f.get("branch") ?? "") || null,
            assignMode: mode,
            assignUserId: mode === "user" ? String(f.get("user")) || null : null,
            poolUserIds: mode === "round_robin" ? pool : [],
          });
          if (r.ok) onSaved(r); else setError(r);
        });
      }}>
        <h2 className="text-lg font-semibold">{rule ? "Edit rule" : "New rule"}</h2>
        <Field label="Name" htmlFor="rule-name"><input id="rule-name" name="name" required defaultValue={rule?.name ?? ""} placeholder="e.g. Facebook leads to Maria" className={inputClasses} /></Field>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium">When a lead…</legend>
          <Field label="comes from" htmlFor="rule-source"><select id="rule-source" name="source" defaultValue={rule?.matchSource ?? ""} className={inputClasses}><option value="">Any source</option>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{LEAD_SOURCE_LABELS[s]}</option>)}</select></Field>
          <Field label="and mentions (optional)" htmlFor="rule-service" hint="Matches words in what they're interested in, e.g. “laser” or “botox”."><input id="rule-service" name="service" defaultValue={rule?.matchServiceInterest ?? ""} className={inputClasses} /></Field>
          {branches.length > 1 && <Field label="for branch" htmlFor="rule-branch"><select id="rule-branch" name="branch" defaultValue={rule?.matchBranchId ?? ""} className={inputClasses}><option value="">Any branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
        </fieldset>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium">…then</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={mode === "user"} onChange={() => setMode("user")} /> Give it to one person</label>
          {mode === "user" && <select name="user" aria-label="Person" defaultValue={rule?.assignUserId ?? ""} required className={inputClasses}><option value="">Choose…</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select>}
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={mode === "round_robin"} onChange={() => setMode("round_robin")} /> Take turns between several people</label>
          {mode === "round_robin" && (
            <div className="flex flex-wrap gap-1.5">
              {staff.map((s) => {
                const on = pool.includes(s.id);
                return <button key={s.id} type="button" aria-pressed={on} onClick={() => setPool(on ? pool.filter((x) => x !== s.id) : [...pool, s.id])}
                  className={`min-h-9 rounded-full border px-3 text-sm ${on ? "border-brand bg-brand-soft font-medium text-brand" : "border-line-strong text-ink-muted"}`}>{s.fullName}</button>;
              })}
            </div>
          )}
        </fieldset>
        {error && !error.ok && <p role="alert" className="text-sm text-critical">{error.message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => ref.current?.close()} className={buttonClasses("ghost")}>Cancel</button>
          <button disabled={pending} className={buttonClasses("primary")}>{pending ? "Saving…" : "Save rule"}</button>
        </div>
      </form>
    </dialog>
  );
}
