import { relations } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clinicIdColumn, primaryId, timestamps } from "./_shared";
import { leadSourceEnum } from "./enums";
import { branches, clinics, users } from "./tenancy";

/**
 * Routing rules (PRD LEAD-03).
 *
 * Evaluated in `priority` order, lowest first, and the first match wins. The
 * order must be deterministic — two rules that could both match must resolve
 * the same way every time — so `priority` is unique per clinic rather than
 * relying on insertion order or an unstable sort.
 *
 * No match leaves the lead unassigned, which is a visible queue rather than a
 * failure state.
 */
export const assignmentRules = pgTable(
  "assignment_rules",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull(),
    isActive: boolean("is_active").notNull().default(true),

    // --- Conditions. A null condition means "any"; all non-null ones must match.
    matchSource: leadSourceEnum("match_source"),
    /** Case-insensitive substring of the lead's service interest. */
    matchServiceInterest: text("match_service_interest"),
    matchBranchId: uuid("match_branch_id").references(() => branches.id, { onDelete: "cascade" }),

    // --- Action
    /**
     * `user` assigns to `assignUserId`. `round_robin` cycles through
     * `poolUserIds` in order, resuming after `lastAssignedUserId`.
     */
    assignMode: text("assign_mode").notNull().default("user"),
    assignUserId: uuid("assign_user_id").references(() => users.id, { onDelete: "set null" }),
    poolUserIds: jsonb("pool_user_ids").$type<string[]>().notNull().default([]),
    /** Round-robin cursor. Null starts the pool from the beginning. */
    lastAssignedUserId: uuid("last_assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    lastMatchedAt: timestamp("last_matched_at", { withTimezone: true, mode: "date" }),
    matchCount: integer("match_count").notNull().default(0),

    ...timestamps(),
  },
  (t) => [
    // Deterministic ordering is a requirement, not a convenience.
    uniqueIndex("assignment_rules_clinic_priority_key").on(t.clinicId, t.priority),
    index("assignment_rules_clinic_active_idx").on(t.clinicId, t.isActive),
  ],
);

export const assignmentRulesRelations = relations(assignmentRules, ({ one }) => ({
  clinic: one(clinics, { fields: [assignmentRules.clinicId], references: [clinics.id] }),
  assignee: one(users, { fields: [assignmentRules.assignUserId], references: [users.id] }),
}));

export type AssignmentRule = typeof assignmentRules.$inferSelect;
export type NewAssignmentRule = typeof assignmentRules.$inferInsert;
