import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  ACTIVITY_GROUPS,
  listActivityQuerySchema,
  listNotesQuerySchema,
  type ActivityFeedItem,
  type NoteFeedItem,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { registerRoute } from "../route";
import { clinicDateRangeToUtc, clinicLocalToUtc } from "../calendar/timezone";

const { generalNotes, people, activities, leads } = schema;

/** Escape LIKE wildcards so a search for "50%" means the text "50%". */
const like = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  // --- Notes: every General Note in the clinic -----------------------------
  registerRoute(app, {
    method: "GET",
    url: "/notes",
    auth: { capability: "notes:read" },
    query: listNotesQuerySchema,
    handler: async ({ query }) => {
      const context = getContext();
      const tx = getTx();
      const where: SQL[] = [isNull(generalNotes.archivedAt), isNull(people.archivedAt)];
      if (query.personId) where.push(eq(generalNotes.personId, query.personId));
      const tz = context.clinicTimezone ?? "UTC";
      if (query.from) where.push(gte(generalNotes.createdAt, clinicLocalToUtc(query.from, "00:00", tz)));
      if (query.to) where.push(lt(generalNotes.createdAt, clinicDateRangeToUtc(query.to, query.to, tz).end));
      if (query.pinned) where.push(eq(generalNotes.pinned, true));
      if (query.mine && context.userId) where.push(eq(generalNotes.authorUserId, context.userId));
      if (query.search) {
        where.push(or(ilike(generalNotes.body, like(query.search)), ilike(people.displayName, like(query.search)))!);
      }

      const rows = await tx
        .select({ note: generalNotes, personName: people.displayName })
        .from(generalNotes)
        .innerJoin(people, eq(people.id, generalNotes.personId))
        .where(and(...where))
        .orderBy(desc(generalNotes.createdAt))
        .limit(query.limit + 1)
        .offset(query.offset);

      return {
        items: rows.slice(0, query.limit).map(
          ({ note, personName }): NoteFeedItem => ({
            id: note.id,
            personId: note.personId,
            personName,
            body: note.body,
            pinned: note.pinned,
            authorLabel: note.authorLabel,
            isMine: note.authorUserId !== null && note.authorUserId === context.userId,
            createdAt: note.createdAt.toISOString(),
            editedAt: note.editedAt?.toISOString() ?? null,
          }),
        ),
        hasMore: rows.length > query.limit,
      };
    },
  });

  // --- Activity: everything that happened ----------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/activities",
    auth: { capability: "leads:read" },
    query: listActivityQuerySchema,
    handler: async ({ query }) => {
      const context = getContext();
      const tx = getTx();
      const where: SQL[] = [];
      if (query.personId) where.push(eq(activities.personId, query.personId));
      const tz = context.clinicTimezone ?? "UTC";
      if (query.from) where.push(gte(activities.occurredAt, clinicLocalToUtc(query.from, "00:00", tz)));
      if (query.to) where.push(lt(activities.occurredAt, clinicDateRangeToUtc(query.to, query.to, tz).end));
      if (query.group) where.push(inArray(activities.type, [...ACTIVITY_GROUPS[query.group].types]));
      if (query.mine && context.userId) where.push(eq(activities.actorUserId, context.userId));

      // Staff who may only see their own leads (practitioners) see activity
      // they did, or on leads they own — the same rule as the leads list.
      if (!context.capabilities.has("leads:read_all") && context.userId) {
        where.push(or(eq(activities.actorUserId, context.userId), eq(leads.ownerUserId, context.userId))!);
      }

      const rows = await tx
        .select({ activity: activities, personName: people.displayName, leadCreatedAt: leads.createdAt })
        .from(activities)
        .innerJoin(people, eq(people.id, activities.personId))
        .leftJoin(leads, eq(leads.id, activities.leadId))
        .where(where.length ? and(...where) : sql`true`)
        .orderBy(desc(activities.occurredAt))
        .limit(query.limit + 1)
        .offset(query.offset);

      return {
        items: rows.slice(0, query.limit).map(
          ({ activity, personName, leadCreatedAt }): ActivityFeedItem => ({
            id: activity.id,
            personId: activity.personId,
            personName,
            leadId: activity.leadId,
            leadCreatedAt: leadCreatedAt?.toISOString() ?? null,
            type: activity.type,
            summary: activity.summary,
            body: activity.body,
            actorLabel: activity.actorLabel,
            isMine: activity.actorUserId !== null && activity.actorUserId === context.userId,
            occurredAt: activity.occurredAt.toISOString(),
          }),
        ),
        hasMore: rows.length > query.limit,
      };
    },
  });
}
