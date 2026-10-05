import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clinicIdColumn, primaryId } from "./_shared";
import { clinics, users } from "./tenancy";

/**
 * Saved views (PRD LEAD-01): a named set of list filters — "Unassigned
 * Facebook leads this week" — that one person keeps for themselves or shares
 * with the whole clinic. `query` is the screen's URL parameters, so a view is
 * exactly what you'd get by bookmarking the filtered page.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    /** Who made it; null once that account is deleted (shared views live on). */
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Which screen it belongs to. Only `leads` today. */
    screen: text("screen").notNull(),
    name: text("name").notNull(),
    query: jsonb("query").$type<Record<string, string>>().notNull().default({}),
    shared: boolean("shared").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("saved_views_clinic_screen_idx").on(t.clinicId, t.screen)],
);
