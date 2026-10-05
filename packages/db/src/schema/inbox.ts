
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clinicIdColumn, primaryId, timestamps } from "./_shared";
import { contactChannelEnum, conversationStatusEnum } from "./enums";
import { clinics, users } from "./tenancy";
import { people } from "./people";
import { leads } from "./leads";

/**
 * Shared inbox threads (PRD WA-01…09). One per person per channel: the whole
 * history with a patient reads as one conversation, the way it does on their
 * phone. Messages themselves stay in `messages` (the delivery log) and point
 * here through `messages.conversation_id`.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    channel: contactChannelEnum("channel").notNull().default("whatsapp"),
    /** The inquiry this thread is most about, for the "open lead" link. */
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),

    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    status: conversationStatusEnum("status").notNull().default("open"),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),

    lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "date" }),
    /** Starts the 24-hour free-reply window (PRD WA-06). */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true, mode: "date" }),
    /** First line of the latest message, for the list. Never the full body. */
    lastPreview: text("last_preview"),
    lastDirection: text("last_direction"),
    unreadCount: integer("unread_count").notNull().default(0),

    /**
     * Soft lock while someone is typing a reply (PRD WA-03), so a colleague
     * sees "Dana is replying" instead of sending a second answer. Expires on
     * its own; never blocks anyone for long.
     */
    replyingUserId: uuid("replying_user_id").references(() => users.id, { onDelete: "set null" }),
    replyingUntil: timestamp("replying_until", { withTimezone: true, mode: "date" }),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex("conversations_person_channel_key").on(t.clinicId, t.personId, t.channel),
    index("conversations_list_idx").on(t.clinicId, t.status, t.lastMessageAt),
    index("conversations_assignee_idx").on(t.clinicId, t.assignedUserId),
  ],
);

/** Notes only staff see, kept inside the thread (PRD WA-04). Never sent. */
export const conversationNotes = pgTable(
  "conversation_notes",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorLabel: text("author_label"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("conversation_notes_thread_idx").on(t.conversationId, t.createdAt)],
);

export type Conversation = typeof conversations.$inferSelect;
