import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { LeadSource } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getTx } from "../context";
import { logger } from "../logger";

const { assignmentRules, users } = schema;

export interface RoutingInput {
  source: LeadSource;
  serviceInterest?: string | null;
  branchId?: string | null;
}

export interface RoutingResult {
  ownerUserId: string | null;
  /** Which rule matched, for the timeline entry and the audit trail. */
  ruleId: string | null;
  ruleName: string | null;
}

/**
 * Pick an owner for a new lead (PRD LEAD-03).
 *
 * Rules are evaluated in ascending `priority`, first match wins, and the order
 * is deterministic because `(clinic_id, priority)` is unique. A rule with a
 * null condition matches anything; every non-null condition must match.
 *
 * Returning `{ ownerUserId: null }` is a normal outcome, not an error: the lead
 * lands in the unassigned queue where the front desk can see it.
 */
export async function routeLead(input: RoutingInput): Promise<RoutingResult> {
  const tx = getTx();

  const rules = await tx
    .select()
    .from(assignmentRules)
    .where(eq(assignmentRules.isActive, true))
    .orderBy(asc(assignmentRules.priority));

  const service = input.serviceInterest?.toLowerCase() ?? "";

  for (const rule of rules) {
    if (rule.matchSource && rule.matchSource !== input.source) continue;
    if (rule.matchBranchId && rule.matchBranchId !== input.branchId) continue;
    if (rule.matchServiceInterest) {
      const needle = rule.matchServiceInterest.toLowerCase().trim();
      if (needle !== "" && !service.includes(needle)) continue;
    }

    const ownerUserId = await resolveAssignee(rule);
    if (!ownerUserId) {
      // A rule that names nobody assignable must not silently swallow the lead.
      // Fall through so a lower-priority rule, or the queue, still gets it.
      logger.warn(
        { ruleId: rule.id, ruleName: rule.name },
        "Assignment rule matched but produced no assignable user; falling through",
      );
      continue;
    }

    await tx
      .update(assignmentRules)
      .set({
        lastAssignedUserId: ownerUserId,
        lastMatchedAt: new Date(),
        matchCount: sql`${assignmentRules.matchCount} + 1`,
      })
      .where(eq(assignmentRules.id, rule.id));

    return { ownerUserId, ruleId: rule.id, ruleName: rule.name };
  }

  return { ownerUserId: null, ruleId: null, ruleName: null };
}

/**
 * Resolve a matched rule to an actual user, skipping anyone who is no longer
 * active. A rule pointing at a departed colleague should route onwards rather
 * than assigning work to an account that cannot sign in.
 */
async function resolveAssignee(rule: typeof assignmentRules.$inferSelect): Promise<string | null> {
  if (rule.assignMode === "user") {
    if (!rule.assignUserId) return null;
    return (await isAssignable(rule.assignUserId)) ? rule.assignUserId : null;
  }

  if (rule.assignMode === "round_robin") {
    const pool = rule.poolUserIds ?? [];
    if (pool.length === 0) return null;

    const active: string[] = [];
    for (const userId of pool) {
      if (await isAssignable(userId)) active.push(userId);
    }
    if (active.length === 0) return null;

    // Resume after whoever got the last one. An unknown or departed cursor
    // starts the cycle again rather than throwing.
    const lastIndex = rule.lastAssignedUserId ? active.indexOf(rule.lastAssignedUserId) : -1;
    return active[(lastIndex + 1) % active.length]!;
  }

  return null;
}

async function isAssignable(userId: string): Promise<boolean> {
  const tx = getTx();
  // RLS confines this to the clinic, so a foreign id simply will not be found.
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "active"), isNull(users.archivedAt)))
    .limit(1);
  return rows.length > 0;
}
