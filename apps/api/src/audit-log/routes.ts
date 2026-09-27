import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AUDIT_ACTIONS, isoDate, uuidSchema } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { registerRoute } from "../route";
import { clinicLocalToUtc } from "../calendar/timezone";

const { auditEvents, users } = schema;

/**
 * Read the audit trail (PRD AUD-01). Admin only. The trail itself is
 * append-only (the app role cannot update or delete it), and change summaries
 * never contain personal data or note text, so this is safe to show in full.
 */
export function registerAuditLogRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "GET",
    url: "/audit-events",
    auth: { capability: "audit:read" },
    query: z.object({
      action: z.enum(AUDIT_ACTIONS).optional(),
      actorUserId: uuidSchema.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    handler: async ({ query }) => {
      const tz = getContext().clinicTimezone ?? "UTC";
      const where: SQL[] = [];
      if (query.action) where.push(eq(auditEvents.action, query.action));
      if (query.actorUserId) where.push(eq(auditEvents.actorUserId, query.actorUserId));
      if (query.from) where.push(gte(auditEvents.occurredAt, clinicLocalToUtc(query.from, "00:00", tz)));
      if (query.to) {
        const next = new Date(`${query.to}T12:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        where.push(lt(auditEvents.occurredAt, clinicLocalToUtc(next.toISOString().slice(0, 10), "00:00", tz)));
      }
      const rows = await getTx()
        .select({ e: auditEvents, actorName: users.fullName })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(auditEvents.occurredAt))
        .limit(query.limit + 1)
        .offset(query.offset);
      return {
        items: rows.slice(0, query.limit).map(({ e, actorName }) => ({
          id: e.id,
          action: e.action,
          actor: actorName ?? e.actorLabel ?? (e.actorUserId ? "Former staff member" : "System"),
          entityType: e.entityType,
          entityId: e.entityId,
          changeSummary: e.changeSummary,
          ipAddress: e.ipAddress,
          occurredAt: e.occurredAt.toISOString(),
        })),
        hasMore: rows.length > query.limit,
      };
    },
  });
}
