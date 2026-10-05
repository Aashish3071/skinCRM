import { bigint, date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clinicIdColumn, primaryId } from "./_shared";
import { clinics, users } from "./tenancy";

/**
 * Ad accounts managed from SkinCRM (D-95). Spend is copied daily per campaign
 * so Reports can show cost per lead, booking and new client next to the CRM's
 * own outcomes. Audiences are customer lists SkinCRM keeps in step on Meta or
 * Google Ads.
 */
export const adSpendDaily = pgTable(
  "ad_spend_daily",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    platform: text("platform").$type<"meta" | "google">().notNull(),
    campaignId: text("campaign_id").notNull(),
    campaignName: text("campaign_name").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    spendMicros: bigint("spend_micros", { mode: "number" }).notNull(),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ad_spend_daily_key").on(t.clinicId, t.platform, t.campaignId, t.day)],
);

export const AUDIENCE_SEGMENTS = ["marketing_consented", "won", "booked_not_won", "leads_not_booked"] as const;
export type AudienceSegment = (typeof AUDIENCE_SEGMENTS)[number];

export const adAudiences = pgTable("ad_audiences", {
  id: primaryId(),
  clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
  platform: text("platform").$type<"meta" | "google">().notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  segment: text("segment").$type<AudienceSegment>().notNull(),
  memberCount: integer("member_count").notNull().default(0),
  status: text("status").$type<"healthy" | "error" | "pending">().notNull().default("pending"),
  lastError: text("last_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
