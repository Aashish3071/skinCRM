import type { FastifyInstance } from "fastify";
import { and, asc, eq, or } from "drizzle-orm";
import { z } from "zod";
import {
  SAVED_VIEW_SCREENS,
  bulkAssignSchema,
  createSavedViewSchema,
  updateSavedViewSchema,
  uuidSchema,
  type SavedViewDto,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { AppError, forbidden, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { assignLead } from "./service";

const { savedViews, users } = schema;
const MAX_VIEWS_PER_PERSON = 30;

function toDto(row: typeof savedViews.$inferSelect, ownerName: string | null): SavedViewDto {
  return {
    id: row.id,
    screen: row.screen as SavedViewDto["screen"],
    name: row.name,
    query: row.query,
    shared: row.shared,
    ownerName,
    isMine: row.ownerUserId === getContext().userId,
  };
}

/** Yours to change, or a shared one an admin is tidying up. */
async function editable(id: string) {
  const context = getContext();
  const [row] = await getTx().select().from(savedViews).where(eq(savedViews.id, id)).limit(1);
  if (!row || (!row.shared && row.ownerUserId !== context.userId)) throw notFound("No such view.");
  if (row.ownerUserId !== context.userId && context.role !== "admin") throw forbidden("Only the person who made this view, or an admin, can change it.");
  return row;
}

export function registerSavedViewRoutes(app: FastifyInstance): void {
  // --- Saved views (PRD LEAD-01) ---------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/saved-views",
    auth: { capability: "leads:read" },
    query: z.object({ screen: z.enum(SAVED_VIEW_SCREENS) }),
    handler: async ({ query }) => {
      const context = getContext();
      const rows = await getTx()
        .select({ view: savedViews, ownerName: users.fullName })
        .from(savedViews)
        .leftJoin(users, eq(users.id, savedViews.ownerUserId))
        .where(and(eq(savedViews.screen, query.screen), or(eq(savedViews.ownerUserId, context.userId!), eq(savedViews.shared, true))))
        .orderBy(asc(savedViews.name));
      return { items: rows.map((r) => toDto(r.view, r.ownerName)) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/saved-views",
    auth: { capability: "leads:read" },
    body: createSavedViewSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();
      const mine = await tx.select({ id: savedViews.id }).from(savedViews).where(eq(savedViews.ownerUserId, context.userId!));
      if (mine.length >= MAX_VIEWS_PER_PERSON) throw new AppError(400, "too_many_views", `You have ${MAX_VIEWS_PER_PERSON} saved views. Delete one first.`);
      // Sharing changes what colleagues see, so it follows the admin rule below.
      if (body.shared && context.role !== "admin") throw forbidden("Only an admin can share a view with the whole clinic.");
      const [row] = await tx.insert(savedViews).values({
        clinicId: context.clinicId!, ownerUserId: context.userId, screen: body.screen, name: body.name, query: body.query, shared: body.shared,
      }).returning();
      if (body.shared) await recordAudit({ action: "settings_changed", entityType: "saved_view", entityId: row!.id, changeSummary: { sharedView: body.name } });
      return toDto(row!, null);
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/saved-views/:id",
    auth: { capability: "leads:read" },
    params: z.object({ id: uuidSchema }),
    body: updateSavedViewSchema,
    handler: async ({ params, body }) => {
      const before = await editable(params.id);
      if (body.shared !== undefined && body.shared !== before.shared && getContext().role !== "admin") {
        throw forbidden("Only an admin can share a view with the whole clinic.");
      }
      const [row] = await getTx().update(savedViews).set({ ...body, updatedAt: new Date() }).where(eq(savedViews.id, params.id)).returning();
      return toDto(row!, null);
    },
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/saved-views/:id",
    auth: { capability: "leads:read" },
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      await editable(params.id);
      await getTx().delete(savedViews).where(eq(savedViews.id, params.id));
      return null;
    },
  });

  // --- Bulk assignment (PRD LEAD-03) -----------------------------------------
  /**
   * Hand a batch of leads to one person, or back to the queue. Each lead goes
   * through the same assignLead() as a single change — notifications, timeline
   * activity and the owner check included — so bulk never skips a rule.
   */
  registerRoute(app, {
    method: "POST",
    url: "/leads/bulk-assign",
    auth: { capability: "leads:bulk_edit" },
    body: bulkAssignSchema,
    handler: async ({ body }) => {
      const ids = [...new Set(body.leadIds)];
      let changed = 0;
      let unchanged = 0;
      const missing: string[] = [];
      for (const leadId of ids) {
        const before = await getTx().select({ owner: schema.leads.ownerUserId }).from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1);
        if (!before[0]) {
          missing.push(leadId);
        } else if (before[0].owner === body.ownerUserId) {
          unchanged += 1;
        } else {
          // An inactive owner fails here for the first lead, before anything changes.
          await assignLead({ leadId, ownerUserId: body.ownerUserId, note: body.note ?? null });
          changed += 1;
        }
      }
      await recordAudit({
        action: "record_updated",
        entityType: "lead",
        changeSummary: { bulkAssign: { to: body.ownerUserId, changed, unchanged, missing: missing.length } },
      });
      return { changed, unchanged, missing: missing.length };
    },
  });
}
