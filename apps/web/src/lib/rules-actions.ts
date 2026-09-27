"use server";

import { revalidatePath } from "next/cache";
import type { CreateAssignmentRule, LeadRulesSettings } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

export type RuleResult = { ok: true; detail?: string } | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

async function run(work: () => Promise<string | void>): Promise<RuleResult> {
  try {
    const detail = (await work()) ?? undefined;
    revalidatePath("/settings/lead-rules");
    return { ok: true, detail };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message, fieldErrors: error.details };
    return { ok: false, message: "Could not reach the server. Try again." };
  }
}

export async function saveSlaAction(input: LeadRulesSettings): Promise<RuleResult> {
  return run(async () => { await apiFetch("/settings/lead-rules", { method: "PATCH", body: input }); return "Saved. Applies to new leads from now on."; });
}

export async function saveRuleAction(id: string | null, input: CreateAssignmentRule): Promise<RuleResult> {
  return run(async () => {
    await apiFetch(id ? `/assignment-rules/${id}` : "/assignment-rules", { method: id ? "PATCH" : "POST", body: input });
  });
}

export async function toggleRuleAction(id: string, isActive: boolean): Promise<RuleResult> {
  return run(async () => { await apiFetch(`/assignment-rules/${id}`, { method: "PATCH", body: { isActive } }); });
}

export async function deleteRuleAction(id: string): Promise<RuleResult> {
  return run(async () => { await apiFetch(`/assignment-rules/${id}`, { method: "DELETE" }); });
}

export async function reorderRulesAction(ids: string[]): Promise<RuleResult> {
  return run(async () => { await apiFetch("/assignment-rules/reorder", { method: "POST", body: { ids } }); });
}

export async function previewRuleAction(source: string, serviceInterest: string): Promise<RuleResult> {
  return run(async () => {
    const r = await apiFetch<{ matched: boolean; ruleName: string | null }>("/assignment-rules/preview", {
      method: "POST",
      body: { source, serviceInterest: serviceInterest || undefined },
    });
    return r.matched ? `Rule “${r.ruleName}” would pick it up.` : "No rule matches — it would wait in the Unassigned queue.";
  });
}
