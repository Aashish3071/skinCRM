import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { NotificationType } from "@skincrm/contracts";
import { clinicIdColumn, primaryId } from "./_shared";
import { clinics, users } from "./tenancy";

/**
 * In-app notifications, one row per person. `dedupe_key` is unique per user:
 * a repeat of the same thing (another message in the same WhatsApp chat)
 * bumps the existing row back to unread and to the top instead of piling up.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<NotificationType>().notNull(),
    title: text("title").notNull(),
    /** Short and safe to show on a shared screen: names, never note text. */
    body: text("body"),
    link: text("link"),
    dedupeKey: text("dedupe_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notifications_user_dedupe_key").on(t.userId, t.dedupeKey),
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
  ],
);
