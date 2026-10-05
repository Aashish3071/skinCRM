import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { aliasedTable, and, desc, eq, lt, ilike, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  WHATSAPP_SERVICE_WINDOW_HOURS,
  assignConversationSchema,
  conversationNoteSchema,
  listConversationsQuerySchema,
  replySchema,
  setConversationStatusSchema,
  simulateInboundSchema,
  startConversationSchema,
  uuidSchema,
  type ConversationDetail,
  type ConversationSummary,
  type ThreadItem,
} from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { getPerson } from "../people/service";
import { sendMessage } from "../messaging/service";
import { receiveInboundWhatsApp } from "./service";
import { ensureConversation } from "./store";

const { conversations, conversationNotes, messages, people, users, automationRules } = schema;
const WINDOW_MS = WHATSAPP_SERVICE_WINDOW_HOURS * 60 * 60 * 1000;
/** How long "Dana is replying" holds after their last keystroke. */
const REPLYING_MS = 45_000;

export function registerInboxRoutes(app: FastifyInstance): void {
  // --- List ------------------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/conversations",
    auth: { capability: "conversations:read" },
    query: listConversationsQuerySchema,
    handler: async ({ query }) => {
      const context = getContext();
      const assignee = aliasedTable(users, "assignee");
      const where: SQL[] = [];
      if (query.view === "done") where.push(eq(conversations.status, "resolved"));
      else where.push(ne(conversations.status, "resolved"));
      if (query.view === "mine") where.push(eq(conversations.assignedUserId, context.userId!));
      if (query.view === "unassigned") where.push(isNull(conversations.assignedUserId));
      if (query.view === "unread") where.push(sql`${conversations.unreadCount} > 0`);
      if (query.search) {
        const term = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(or(ilike(people.displayName, term), ilike(people.phoneE164, term), sql`${conversations.tags}::text ilike ${term}`)!);
      }
      // A thread with nothing in it yet is noise in the list.
      where.push(sql`${conversations.lastMessageAt} is not null`);

      const rows = await getTx()
        .select({ c: conversations, personName: people.displayName, assignedName: assignee.fullName })
        .from(conversations)
        .innerJoin(people, eq(people.id, conversations.personId))
        .leftJoin(assignee, eq(assignee.id, conversations.assignedUserId))
        .where(and(...where))
        .orderBy(desc(conversations.unreadCount), desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(query.limit + 1).offset(query.offset);

      const counts = await getTx()
        .select({
          open: sql<number>`count(*) filter (where ${conversations.status} <> 'resolved')::int`,
          unread: sql<number>`count(*) filter (where ${conversations.unreadCount} > 0 and ${conversations.status} <> 'resolved')::int`,
          mine: sql<number>`count(*) filter (where ${conversations.status} <> 'resolved' and ${conversations.assignedUserId} = ${context.userId})::int`,
          unassigned: sql<number>`count(*) filter (where ${conversations.status} <> 'resolved' and ${conversations.assignedUserId} is null)::int`,
        })
        .from(conversations)
        .where(sql`${conversations.lastMessageAt} is not null`);

      return {
        items: rows.slice(0, query.limit).map((r) => summarize(r.c, r.personName, r.assignedName)),
        offset: query.offset,
        nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
        counts: counts[0] ?? { open: 0, unread: 0, mine: 0, unassigned: 0 },
        simulateAvailable: getEnv().CONNECTOR_WHATSAPP === "mock" && getEnv().NODE_ENV !== "production",
      };
    },
  });

  // --- One thread ------------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/conversations/:id",
    auth: { capability: "conversations:read" },
    params: z.object({ id: uuidSchema }),
    query: z.object({ before: z.string().datetime().optional(), beforeId: uuidSchema.optional() }).refine((q) => Boolean(q.before) === Boolean(q.beforeId), "Provide both cursor fields"),
    handler: async ({ params, query }): Promise<ConversationDetail> => {
      const context = getContext();
      const tx = getTx();
      const assignee = aliasedTable(users, "assignee");
      const replier = aliasedTable(users, "replier");
      const row = (
        await tx
          .select({
            c: conversations,
            personName: people.displayName,
            personPhone: people.phoneRaw,
            assignedName: assignee.fullName,
            replyingName: replier.fullName,
          })
          .from(conversations)
          .innerJoin(people, eq(people.id, conversations.personId))
          .leftJoin(assignee, eq(assignee.id, conversations.assignedUserId))
          .leftJoin(replier, eq(replier.id, conversations.replyingUserId))
          .where(eq(conversations.id, params.id))
          .limit(1)
      )[0];
      if (!row) throw notFound("No such conversation.");

      const sender = aliasedTable(users, "sender");
      const olderMessages = query.before ? or(lt(messages.createdAt, new Date(query.before)), and(eq(messages.createdAt, new Date(query.before)), lt(messages.id, query.beforeId!))) : undefined;
      const olderNotes = query.before ? or(lt(conversationNotes.createdAt, new Date(query.before)), and(eq(conversationNotes.createdAt, new Date(query.before)), lt(conversationNotes.id, query.beforeId!))) : undefined;
      const [msgs, notes] = await Promise.all([
        tx
          .select({ m: messages, senderName: sender.fullName, ruleName: automationRules.name })
          .from(messages)
          .leftJoin(sender, eq(sender.id, messages.triggeredByUserId))
          .leftJoin(automationRules, eq(automationRules.id, messages.ruleId))
          .where(and(eq(messages.conversationId, params.id), olderMessages))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(101),
        tx.select().from(conversationNotes).where(and(eq(conversationNotes.conversationId, params.id), olderNotes)).orderBy(desc(conversationNotes.createdAt), desc(conversationNotes.id)).limit(101),
      ]);

      const items: ThreadItem[] = [
        ...msgs.map(({ m, senderName, ruleName }): ThreadItem => ({
          kind: "message",
          id: m.id,
          direction: m.direction,
          body: m.renderedBody,
          state: m.state,
          suppressionReason: m.suppressionReason,
          failureDetail: m.failureDetail,
          byLabel: m.direction === "inbound" ? null : (senderName ?? (ruleName ? null : "System")),
          automationName: ruleName,
          at: m.createdAt.toISOString(),
        })),
        ...notes.map((n): ThreadItem => ({ kind: "note", id: n.id, body: n.body, byLabel: n.authorLabel, at: n.createdAt.toISOString() })),
      ].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      const page = items.slice(0, 100);
      const oldest = page.at(-1);

      const replyingActive =
        row.c.replyingUserId && row.c.replyingUserId !== context.userId && row.c.replyingUntil && row.c.replyingUntil > new Date();

      return {
        ...summarize(row.c, row.personName, row.assignedName),
        personPhone: row.personPhone,
        replyingName: replyingActive ? row.replyingName : null,
        items: page.reverse(),
        nextCursor: items.length > 100 && oldest ? { before: oldest.at, beforeId: oldest.id } : null,
      };
    },
  });

  // --- Start (from a lead or profile) ----------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/conversations",
    auth: { capability: "conversations:write" },
    body: startConversationSchema,
    handler: async ({ body }) => {
      const person = await getPerson(body.personId);
      if (!person.phoneE164) throw badRequest("They have no phone number on file, so there is no WhatsApp to message.");
      return { id: await ensureConversation(person.id, "whatsapp") };
    },
  });

  // --- Read, typing, assign, status ------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/conversations/:id/read",
    auth: { capability: "conversations:read" },
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      await getTx().update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, params.id));
      return null;
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/conversations/:id/typing",
    auth: { capability: "conversations:write" },
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      const context = getContext();
      // Only take the lock if nobody else holds a live one.
      await getTx()
        .update(conversations)
        .set({ replyingUserId: context.userId, replyingUntil: new Date(Date.now() + REPLYING_MS) })
        .where(
          and(
            eq(conversations.id, params.id),
            or(
              isNull(conversations.replyingUntil),
              sql`${conversations.replyingUntil} < now()`,
              eq(conversations.replyingUserId, context.userId!),
            ),
          ),
        );
      return null;
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/conversations/:id/assign",
    auth: { capability: "conversations:assign" },
    params: z.object({ id: uuidSchema }),
    body: assignConversationSchema,
    status: 204,
    handler: async ({ params, body }) => {
      const tx = getTx();
      const convo = await load(params.id);
      if (body.userId) {
        const user = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, body.userId), isNull(users.archivedAt))).limit(1);
        if (!user[0]) throw badRequest("That person is not active staff here.");
      }
      await tx.update(conversations).set({ assignedUserId: body.userId, updatedAt: new Date() }).where(eq(conversations.id, convo.id));
      await recordAudit({ action: "record_updated", entityType: "conversation", entityId: convo.id, changeSummary: { assigned: { from: convo.assignedUserId, to: body.userId } } });
      return null;
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/conversations/:id/status",
    auth: { capability: "conversations:write" },
    params: z.object({ id: uuidSchema }),
    body: setConversationStatusSchema,
    status: 204,
    handler: async ({ params, body }) => {
      const convo = await load(params.id);
      await getTx().update(conversations).set({ status: body.status, unreadCount: body.status === "resolved" ? 0 : convo.unreadCount, updatedAt: new Date() }).where(eq(conversations.id, convo.id));
      return null;
    },
  });

  // --- Internal note (PRD WA-04) ----------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/conversations/:id/notes",
    auth: { capability: "conversations:write" },
    params: z.object({ id: uuidSchema }),
    body: conversationNoteSchema,
    status: 201,
    handler: async ({ params, body }) => {
      const context = getContext();
      const convo = await load(params.id);
      const me = (await getTx().select({ name: users.fullName }).from(users).where(eq(users.id, context.userId!)).limit(1))[0];
      const inserted = await getTx()
        .insert(conversationNotes)
        .values({ clinicId: context.clinicId!, conversationId: convo.id, body: body.body, authorUserId: context.userId, authorLabel: me?.name ?? null })
        .returning({ id: conversationNotes.id });
      return { id: inserted[0]!.id };
    },
  });

  // --- Reply (PRD WA-05, WA-06) ------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/conversations/:id/reply",
    auth: { capability: "messages:send" },
    params: z.object({ id: uuidSchema }),
    body: replySchema,
    handler: async ({ params, body }) => {
      const context = getContext();
      const tx = getTx();
      const convo = await load(params.id);

      // Someone else is mid-reply: say so rather than let two answers go out.
      if (convo.replyingUserId && convo.replyingUserId !== context.userId && convo.replyingUntil && convo.replyingUntil > new Date()) {
        const other = (await tx.select({ name: users.fullName }).from(users).where(eq(users.id, convo.replyingUserId)).limit(1))[0];
        throw conflict(`${other?.name ?? "A colleague"} is replying to this conversation right now. Wait a moment and read their reply first.`);
      }

      const outcome = await sendMessage({
        personId: convo.personId,
        leadId: convo.leadId,
        conversationId: convo.id,
        templateKey: body.templateKey ?? undefined,
        // Reply on the thread's own channel: an email thread answers by email (D-96).
        adHoc: body.templateKey ? undefined : convo.channel === "email"
          ? { channel: "email", subject: await replySubject(convo.id), body: body.body! }
          : { channel: "whatsapp", body: body.body! },
        idempotencyKey: `inbox:${convo.id}:${body.requestId ?? randomUUID()}`,
        // Staff are answering a person who wrote to them; quiet hours are for
        // automated messages, not a conversation happening now.
        ignoreQuietHours: true,
      });

      // Replying claims an unowned thread, so it doesn't sit in the queue.
      await tx
        .update(conversations)
        .set({
          assignedUserId: convo.assignedUserId ?? context.userId,
          replyingUserId: null,
          replyingUntil: null,
          unreadCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, convo.id));

      return outcome;
    },
  });

  registerRoute(app, { method: "PATCH", url: "/conversations/:id/tags", auth: { capability: "conversations:write" }, params: z.object({ id: uuidSchema }), body: z.object({ tags: z.array(z.string().trim().min(1).max(40)).max(12) }), handler: async ({ params, body }) => {
    await load(params.id);
    const tags = [...new Set(body.tags.map((t) => t.toLowerCase()))];
    await getTx().update(conversations).set({ tags, updatedAt: new Date() }).where(eq(conversations.id, params.id));
    await recordAudit({ action: "record_updated", entityType: "conversation", entityId: params.id, changeSummary: { tags } });
    return { tags };
  } });

  // --- Development: simulate a patient writing in -----------------------------
  registerRoute(app, {
    method: "POST",
    url: "/inbox/simulate",
    auth: { capability: "conversations:write" },
    body: simulateInboundSchema,
    handler: async ({ body }) => {
      if (getEnv().CONNECTOR_WHATSAPP !== "mock" || getEnv().NODE_ENV === "production") {
        throw forbidden("Simulated messages are only available with the mock WhatsApp connector.");
      }
      return receiveInboundWhatsApp({
        waId: body.phone,
        profileName: body.name,
        body: body.body,
        providerMessageId: `sim-${randomUUID()}`,
      });
    },
  });
}

async function load(id: string) {
  const rows = await getTx().select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!rows[0]) throw notFound("No such conversation.");
  return rows[0];
}

function summarize(
  c: typeof conversations.$inferSelect,
  personName: string,
  assignedName: string | null,
): ConversationSummary {
  const until = c.lastInboundAt ? new Date(c.lastInboundAt.getTime() + WINDOW_MS) : null;
  return {
    id: c.id,
    personId: c.personId,
    personName,
    channel: c.channel === "email" ? "email" : "whatsapp",
    tags: c.tags,
    leadId: c.leadId,
    status: c.status,
    assignedUserId: c.assignedUserId,
    assignedName,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastPreview: c.lastPreview,
    lastDirection: c.lastDirection,
    unreadCount: c.unreadCount,
    windowOpenUntil: until && until > new Date() ? until.toISOString() : null,
  };
}

/** "Re: <their last subject>" for an email thread. */
async function replySubject(conversationId: string): Promise<string> {
  const [last] = await getTx().select({ subject: schema.messages.renderedSubject }).from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "inbound")))
    .orderBy(desc(schema.messages.createdAt)).limit(1);
  const subject = last?.subject?.trim() || "Your message";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

