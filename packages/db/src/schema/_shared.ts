import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Primary key. UUID v4 from pgcrypto so IDs are stable, non-guessable and safe
 * to expose in URLs (PRD 5: "Prefer stable UUIDs for internal IDs").
 */
export const primaryId = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

/**
 * Tenant discriminator. Present on every tenant-scoped table and covered by a
 * row-level-security policy (see src/sql/*_rls.sql). Never nullable: a row with
 * no clinic would be invisible to every tenant and leak on a policy mistake.
 */
export const clinicIdColumn = () => uuid("clinic_id").notNull();

/** All instants are `timestamptz` and stored in UTC (BRD 9). */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Soft delete. Records stay recoverable for a configurable period unless a
 * valid deletion request requires hard removal (BRD 7).
 */
export const archivedAt = () => timestamp("archived_at", { withTimezone: true, mode: "date" });
