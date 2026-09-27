import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Operational heartbeats (phase 9): not tenant data, no clinic_id, and not
 * readable by the application role (revoked in 900_rls.sql). The worker writes
 * `worker`, the backup script writes `backup`, and the monitor records when it
 * last alerted about each problem so it doesn't email every five minutes.
 */
export const opsHeartbeats = pgTable("ops_heartbeats", {
  key: text("key").primaryKey(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  detail: text("detail"),
});
