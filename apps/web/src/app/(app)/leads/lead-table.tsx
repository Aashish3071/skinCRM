"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LEAD_SOURCE_LABELS, type LeadDto } from "@skincrm/contracts";
import { Badge, Card, buttonClasses, inputClasses } from "@/components/ui";
import { relativeTime, stageTone } from "@/lib/format";
import { bulkAssignAction, type ViewResult } from "@/lib/view-actions";

/**
 * The list view. With bulk editing allowed, each row gets a checkbox and a
 * bar appears once anything is ticked: choose a person (or the unassigned
 * queue) and apply. Every lead goes through the normal assignment rules.
 */
export function LeadTable({ leads, assignees, canBulk }: { leads: LeadDto[]; assignees: { id: string; fullName: string }[]; canBulk: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState("");
  const [result, setResult] = useState<ViewResult | null>(null);
  const [pending, start] = useTransition();
  const allSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const apply = () => start(async () => {
    const r = await bulkAssignAction([...selected], owner === "queue" ? null : owner);
    setResult(r);
    if (r.ok) {
      setSelected(new Set());
      router.refresh();
    }
  });

  return (
    <>
      {canBulk && selected.size > 0 && (
        <div role="region" aria-label="Bulk actions" className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-card border border-brand bg-brand-soft p-3">
          <p className="text-sm font-medium">{selected.size} selected</p>
          <label htmlFor="bulk-owner" className="sr-only">Assign to</label>
          <select id="bulk-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={`${inputClasses} w-auto min-w-48`}>
            <option value="">Assign to…</option>
            <option value="queue">Unassigned queue</option>
            {assignees.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
          </select>
          <button type="button" disabled={!owner || pending} onClick={apply} className={buttonClasses("primary", "sm")}>
            {pending ? "Assigning…" : "Apply"}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className={buttonClasses("ghost", "sm")}>Clear selection</button>
        </div>
      )}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={`mb-3 rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-positive-soft text-positive" : "bg-critical-soft text-critical"}`}>
          {result.ok ? result.detail : result.message}
        </p>
      )}
      <Card>
        <div className="-my-4 sm:-mx-5 sm:overflow-x-auto">
          <table className="stack-table w-full text-sm">
            <caption className="sr-only">Leads</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-subtle">
                {canBulk && (
                  <th scope="col" className="w-10 py-3 pl-5">
                    <input type="checkbox" aria-label="Select all leads on this page" checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)))} />
                  </th>
                )}
                <th scope="col" className="px-5 py-3 font-medium">Name</th>
                <th scope="col" className="px-3 py-3 font-medium">Stage</th>
                <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">Source</th>
                <th scope="col" className="hidden px-3 py-3 font-medium md:table-cell">Owner</th>
                <th scope="col" className="px-5 py-3 text-right font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className={`border-b border-line last:border-0 hover:bg-surface-muted ${selected.has(lead.id) ? "bg-brand-soft/40" : ""}`}>
                  {canBulk && (
                    <td className="py-3 pl-5">
                      <input type="checkbox" aria-label={`Select ${lead.personName}`} checked={selected.has(lead.id)} onChange={() => toggle(lead.id)} />
                    </td>
                  )}
                  <td className="px-5 py-3">
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:text-brand">{lead.personName}</Link>
                    <div className="text-xs text-ink-muted">{lead.personPhone ?? lead.personEmail ?? "—"}</div>
                  </td>
                  <td data-label="Stage" className="px-3 py-3"><Badge tone={stageTone(lead.stageCategory)}>{lead.stageName}</Badge></td>
                  <td className="hidden px-3 py-3 text-ink-muted sm:table-cell">{LEAD_SOURCE_LABELS[lead.source]}</td>
                  <td className="hidden px-3 py-3 md:table-cell">{lead.ownerName ?? <span className="text-caution">Unassigned</span>}</td>
                  <td data-label="Added" className="px-5 py-3 text-right text-ink-muted">{relativeTime(lead.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
