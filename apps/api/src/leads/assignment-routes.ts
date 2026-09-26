import type { FastifyInstance } from "fastify";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import {
  createAssignmentRuleSchema,
  updateAssignmentRuleSchema,
  uuidSchema,
  type AssignmentRuleDto,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, conflict, notFound } from "../errors";
import { diffSummary, recordAudit } from "../audit";
import { registerRoute } from "../route";

const { assignmentRules, users, branches } = schema;

export function registerAssignmentRuleRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "GET",
    url: "/assignment-rules",
    auth: { capability: "settings:read" },
    handler: async () => {
      const tx = getTx();
      const rows = await tx.select().from(assignmentRules).orderBy(asc(assignmentRules.priority));
      return { items: rows.map(serialize) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/assignment-rules",
    auth: { capability: "settings:write" },
    body: createAssignmentRuleSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();

      await assertPriorityFree(body.priority, null);
      await assertTargetsBelongToClinic(body);

      const inserted = await tx
        .insert(assignmentRules)
        .values({
          clinicId: context.clinicId!,
          name: body.name,
          priority: body.priority,
          isActive: body.isActive,
          matchSource: body.matchSource ?? null,
          matchServiceInterest: body.matchServiceInterest ?? null,
          matchBranchId: body.matchBranchId ?? null,
          assignMode: body.assignMode,
          assignUserId: body.assignUserId ?? null,
          poolUserIds: body.poolUserIds,
        })
        .returning();

      await recordAudit({
        action: "settings_changed",
        entityType: "assignment_rule",
        entityId: inserted[0]!.id,
        changeSummary: { created: body.name, priority: body.priority, mode: body.assignMode },
      });

      return serialize(inserted[0]!);
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/assignment-rules/:id",
    auth: { capability: "settings:write" },
    params: z.object({ id: uuidSchema }),
    body: updateAssignmentRuleSchema,
    handler: async ({ params, body }) => {
      const tx = getTx();
      const before = await loadRule(params.id);

      if (body.priority !== undefined && body.priority !== before.priority) {
        await assertPriorityFree(body.priority, params.id);
      }

      // A partial update can still leave the rule unable to name anyone, so
      // validate the merged result rather than just the fields supplied.
      const merged = {
        assignMode: body.assignMode ?? before.assignMode,
        assignUserId: body.assignUserId !== undefined ? body.assignUserId : before.assignUserId,
        poolUserIds: body.poolUserIds ?? before.poolUserIds,
      };
      if (merged.assignMode === "user" && !merged.assignUserId) {
        throw badRequest("Choose someone to assign to.", { assignUserId: ["Required in user mode"] });
      }
      if (merged.assignMode === "round_robin" && merged.poolUserIds.length === 0) {
        throw badRequest("Add at least one person to the round-robin pool.", {
          poolUserIds: ["Cannot be empty in round-robin mode"],
        });
      }
      await assertTargetsBelongToClinic(merged);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of [
        "name",
        "priority",
        "isActive",
        "matchSource",
        "matchServiceInterest",
        "matchBranchId",
        "assignMode",
        "assignUserId",
        "poolUserIds",
      ] as const) {
        if (body[key] !== undefined) updates[key] = body[key];
      }

      const updated = await tx
        .update(assignmentRules)
        .set(updates)
        .where(eq(assignmentRules.id, params.id))
        .returning();

      await recordAudit({
        action: "settings_changed",
        entityType: "assignment_rule",
        entityId: params.id,
        changeSummary: diffSummary(before as unknown as Record<string, unknown>, updates),
      });

      return serialize(updated[0]!);
    },
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/assignment-rules/:id",
    auth: { capability: "settings:write" },
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      const tx = getTx();
      const rule = await loadRule(params.id);
      await tx.delete(assignmentRules).where(eq(assignmentRules.id, params.id));
      await recordAudit({
        action: "settings_changed",
        entityType: "assignment_rule",
        entityId: params.id,
        changeSummary: { deleted: rule.name },
      });
      return null;
    },
  });

  /**
   * Dry run: show which rule *would* match, without creating anything. Routing
   * that surprises the front desk is worse than no routing, so an admin can
   * check a rule set before turning it on.
   */
  registerRoute(app, {
    method: "POST",
    url: "/assignment-rules/preview",
    auth: { capability: "settings:read" },
    body: z.object({
      source: z.string(),
      serviceInterest: z.string().optional(),
      branchId: uuidSchema.optional(),
    }),
    status: 200,
    handler: async ({ body }) => {
      const tx = getTx();
      const rules = await tx
        .select()
        .from(assignmentRules)
        .where(eq(assignmentRules.isActive, true))
        .orderBy(asc(assignmentRules.priority));

      const service = body.serviceInterest?.toLowerCase() ?? "";
      for (const rule of rules) {
        if (rule.matchSource && rule.matchSource !== body.source) continue;
        if (rule.matchBranchId && rule.matchBranchId !== body.branchId) continue;
        if (rule.matchServiceInterest) {
          const needle = rule.matchServiceInterest.toLowerCase().trim();
          if (needle !== "" && !service.includes(needle)) continue;
        }
        return { matched: true, ruleId: rule.id, ruleName: rule.name, assignMode: rule.assignMode };
      }
      return { matched: false, ruleId: null, ruleName: null, assignMode: null };
    },
  });
}

async function loadRule(id: string) {
  const tx = getTx();
  const rows = await tx.select().from(assignmentRules).where(eq(assignmentRules.id, id)).limit(1);
  const rule = rows[0];
  if (!rule) throw notFound("No such assignment rule.");
  return rule;
}

/**
 * Priority is unique per clinic so evaluation order can never be ambiguous.
 * Checked here to give a clear message instead of a raw constraint violation.
 */
async function assertPriorityFree(priority: number, exceptId: string | null): Promise<void> {
  const tx = getTx();
  const clash = await tx
    .select({ id: assignmentRules.id, name: assignmentRules.name })
    .from(assignmentRules)
    .where(
      exceptId
        ? and(eq(assignmentRules.priority, priority), ne(assignmentRules.id, exceptId))
        : eq(assignmentRules.priority, priority),
    )
    .limit(1);
  if (clash[0]) {
    throw conflict(`Priority ${priority} is already used by "${clash[0].name}". Pick another.`, {
      priority: ["Already in use"],
    });
  }
}

/**
 * RLS makes a foreign user or branch id invisible, which would turn into a rule
 * that silently never assigns. Fail loudly at configuration time instead.
 */
async function assertTargetsBelongToClinic(rule: {
  assignUserId?: string | null;
  poolUserIds?: string[];
  matchBranchId?: string | null;
}): Promise<void> {
  const tx = getTx();

  const userIds = [rule.assignUserId, ...(rule.poolUserIds ?? [])].filter(
    (id): id is string => typeof id === "string",
  );
  if (userIds.length > 0) {
    const found = await tx.select({ id: users.id }).from(users);
    const valid = new Set(found.map((u) => u.id));
    const unknown = userIds.filter((id) => !valid.has(id));
    if (unknown.length > 0) {
      throw badRequest("One or more of those people are not staff at this clinic.", {
        assignUserId: unknown.map((id) => `${id} not found`),
      });
    }
  }

  if (rule.matchBranchId) {
    const found = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, rule.matchBranchId))
      .limit(1);
    if (!found[0]) throw badRequest("That branch does not belong to this clinic.");
  }
}

function serialize(row: typeof assignmentRules.$inferSelect): AssignmentRuleDto {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    isActive: row.isActive,
    matchSource: row.matchSource,
    matchServiceInterest: row.matchServiceInterest,
    matchBranchId: row.matchBranchId,
    assignMode: row.assignMode as AssignmentRuleDto["assignMode"],
    assignUserId: row.assignUserId,
    poolUserIds: row.poolUserIds ?? [],
    lastAssignedUserId: row.lastAssignedUserId,
    matchCount: row.matchCount,
    lastMatchedAt: row.lastMatchedAt?.toISOString() ?? null,
  };
}
