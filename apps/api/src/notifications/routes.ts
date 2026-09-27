import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { NOTIFICATION_TYPES, uuidSchema } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { registerRoute } from "../route";

const { notifications, users } = schema;

/** Your own notifications only: every query is scoped to the signed-in user. */
export function registerNotificationRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "GET",
    url: "/notifications",
    auth: {},
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
    handler: async ({ query }) => {
      const me = getContext().userId!;
      const tx = getTx();
      const [items, unread] = await Promise.all([
        tx.select().from(notifications).where(eq(notifications.userId, me)).orderBy(desc(notifications.createdAt)).limit(query.limit),
        tx.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, me), isNull(notifications.readAt))),
      ]);
      return {
        unreadCount: unread[0]?.n ?? 0,
        items: items.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          link: n.link,
          read: n.readAt !== null,
          createdAt: n.createdAt.toISOString(),
        })),
      };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/notifications/:id/read",
    auth: {},
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      await getTx()
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, params.id), eq(notifications.userId, getContext().userId!)));
      return null;
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/notifications/read-all",
    auth: {},
    status: 204,
    handler: async () => {
      await getTx()
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, getContext().userId!), isNull(notifications.readAt)));
      return null;
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/me/notification-settings",
    auth: {},
    handler: async () => {
      const row = (await getTx().select({ muted: users.mutedNotifications }).from(users).where(eq(users.id, getContext().userId!)).limit(1))[0];
      return { muted: row?.muted ?? [] };
    },
  });

  registerRoute(app, {
    method: "PUT",
    url: "/me/notification-settings",
    auth: {},
    body: z.object({ muted: z.array(z.enum(NOTIFICATION_TYPES)).max(NOTIFICATION_TYPES.length) }),
    handler: async ({ body }) => {
      await getTx().update(users).set({ mutedNotifications: body.muted }).where(eq(users.id, getContext().userId!));
      return body;
    },
  });
}
