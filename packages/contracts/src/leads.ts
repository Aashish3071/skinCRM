import { z } from "zod";
import {
  isoDateTime,
  longText,
  optionalShortText,
  queryBoolean,
  shortText,
  uuidSchema,
} from "./common";
import {
  CONTACT_ATTEMPT_OUTCOMES,
  LEAD_SOURCES,
  STAGE_CATEGORIES,
  TASK_OUTCOMES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type StageCategory,
} from "./enums";

// --- Leads ----------------------------------------------------------------

/**
 * Manual and walk-in intake (PRD ID-03, J2). Deliberately few required fields:
 * the target is under two minutes for a typical walk-in, so anything the front
 * desk can fill in later is optional.
 */
export const createLeadSchema = z.object({
  /** Attach to an existing person, or create one inline. */
  personId: uuidSchema.optional(),
  person: z
    .object({
      firstName: optionalShortText(120),
      lastName: optionalShortText(120),
      phone: optionalShortText(40),
      email: optionalShortText(320),
      allowDuplicate: z.boolean().default(false),
    })
    .optional(),

  source: z.enum(LEAD_SOURCES).default("walk_in"),
  serviceInterest: optionalShortText(200),
  inquiryNote: optionalShortText(4000),
  branchId: uuidSchema.nullish(),
  /** Omit to leave the lead in the unassigned queue (PRD LEAD-03). */
  ownerUserId: uuidSchema.nullish(),
});
export type CreateLead = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = z.object({
  serviceInterest: optionalShortText(200),
  inquiryNote: optionalShortText(4000),
  branchId: uuidSchema.nullish(),
  /**
   * A corrected source for reporting. The original `source` is immutable after
   * ingestion (BRD 7); this sits alongside it with an audit record.
   */
  reportingSource: z.enum(LEAD_SOURCES).nullish(),
});
export type UpdateLead = z.infer<typeof updateLeadSchema>;

/**
 * Moving a lead between stages.
 *
 * `reason` is required when entering a stage the clinic has marked as needing
 * one — Lost and Unqualified by default (PRD LEAD-02). The server enforces it;
 * this schema only carries it.
 */
export const changeStageSchema = z.object({
  stageId: uuidSchema,
  reason: optionalShortText(500),
});
export type ChangeStage = z.infer<typeof changeStageSchema>;

export const assignLeadSchema = z.object({
  /** Null returns the lead to the unassigned queue. */
  ownerUserId: uuidSchema.nullable(),
  note: optionalShortText(500),
});
export type AssignLead = z.infer<typeof assignLeadSchema>;

export const listLeadsQuerySchema = z.object({
  search: optionalShortText(200),
  /** Filter by stable category rather than stage id, so saved filters survive a rename. */
  stageCategory: z.enum(STAGE_CATEGORIES).optional(),
  stageId: uuidSchema.optional(),
  ownerUserId: uuidSchema.optional(),
  /** `unassigned` is a first-class filter: it is the front desk's work queue. */
  unassigned: queryBoolean(false),
  source: z.enum(LEAD_SOURCES).optional(),
  branchId: uuidSchema.optional(),
  /** Clinic-local dates; converted to UTC bounds server-side. */
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  includeClosed: queryBoolean(true),
  /** Providers mark test submissions; excluded from the default view. */
  includeTest: queryBoolean(false),
  sort: z.enum(["newest", "oldest", "recently_updated"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

export const leadSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  personName: z.string(),
  personPhone: z.string().nullable(),
  personEmail: z.string().nullable(),
  /** Position of the furthest open stage reached; earlier stages are locked (D-69). */
  furthestPosition: z.number().int().nullable(),
  source: z.enum(LEAD_SOURCES),
  reportingSource: z.enum(LEAD_SOURCES).nullable(),
  stageId: uuidSchema,
  stageName: z.string(),
  stageCategory: z.enum(STAGE_CATEGORIES),
  isClosed: z.boolean(),
  ownerUserId: uuidSchema.nullable(),
  ownerName: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  serviceInterest: z.string().nullable(),
  inquiryNote: z.string().nullable(),
  isTest: z.boolean(),
  firstContactedAt: isoDateTime.nullable(),
  qualifiedAt: isoDateTime.nullable(),
  bookedAt: isoDateTime.nullable(),
  attendedAt: isoDateTime.nullable(),
  convertedAt: isoDateTime.nullable(),
  closedAt: isoDateTime.nullable(),
  lossReason: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type LeadDto = z.infer<typeof leadSchema>;

// --- Contact attempts and inquiry notes (PRD LEAD-06) ---------------------

export const logContactAttemptSchema = z.object({
  outcome: z.enum(CONTACT_ATTEMPT_OUTCOMES),
  channel: z.enum(["phone", "email", "whatsapp", "in_person"]).default("phone"),
  note: optionalShortText(4000),
  /** Advance the lead in the same action, e.g. straight to Connected. */
  stageId: uuidSchema.optional(),
});
export type LogContactAttempt = z.infer<typeof logContactAttemptSchema>;

export const addLeadNoteSchema = z.object({
  body: longText(4000),
});
export type AddLeadNote = z.infer<typeof addLeadNoteSchema>;

// --- Tasks (PRD LEAD-05) --------------------------------------------------

export const createTaskSchema = z.object({
  title: shortText(200),
  detail: optionalShortText(2000),
  leadId: uuidSchema.optional(),
  personId: uuidSchema.optional(),
  ownerUserId: uuidSchema.nullish(),
  dueAt: isoDateTime,
  priority: z.enum(TASK_PRIORITIES).default("normal"),
});
export type CreateTask = z.infer<typeof createTaskSchema>;

/** Completing a task requires an outcome (PRD LEAD-05). */
export const completeTaskSchema = z.object({
  outcome: z.enum(TASK_OUTCOMES),
  outcomeNote: optionalShortText(2000),
});
export type CompleteTask = z.infer<typeof completeTaskSchema>;

/** Snoozing requires a new due time (PRD LEAD-05). */
export const snoozeTaskSchema = z.object({
  dueAt: isoDateTime,
  note: optionalShortText(500),
});
export type SnoozeTask = z.infer<typeof snoozeTaskSchema>;

export const listTasksQuerySchema = z.object({
  ownerUserId: uuidSchema.optional(),
  mine: queryBoolean(false),
  status: z.enum(TASK_STATUSES).optional(),
  /** Due now or earlier, in the clinic's timezone. */
  dueView: z.enum(["all", "overdue", "today", "upcoming"]).default("all"),
  leadId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const taskSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  detail: z.string().nullable(),
  leadId: uuidSchema.nullable(),
  personId: uuidSchema.nullable(),
  personName: z.string().nullable(),
  ownerUserId: uuidSchema.nullable(),
  ownerName: z.string().nullable(),
  dueAt: isoDateTime,
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  outcome: z.enum(TASK_OUTCOMES).nullable(),
  outcomeNote: z.string().nullable(),
  completedAt: isoDateTime.nullable(),
  /** True when the lead this task belongs to has been closed (PRD LEAD-05). */
  leadClosed: z.boolean(),
  createdAt: isoDateTime,
});
export type TaskDto = z.infer<typeof taskSchema>;

// --- Stage milestones -----------------------------------------------------

/**
 * Which lead timestamp a stage category sets when first reached.
 *
 * Milestones are written once and never moved. If a lead bounces back and
 * forth, the original time is the truthful "when did this actually happen",
 * and re-stamping it would make conversion feedback report the same outcome
 * twice with different event times (PRD FB-05).
 */
export const STAGE_MILESTONE_FIELD: Partial<Record<StageCategory, string>> = {
  qualified: "qualifiedAt",
  consultation_booked: "bookedAt",
  consultation_attended: "attendedAt",
  converted: "convertedAt",
};

/** Categories that a conversion-feedback rule may be mapped to (PRD FB-01). */
export const FEEDBACK_ELIGIBLE_CATEGORIES: readonly StageCategory[] = [
  "qualified",
  "consultation_booked",
  "consultation_attended",
  "converted",
];

// --- Assignment rules (PRD LEAD-03) ---------------------------------------

export const ASSIGN_MODES = ["user", "round_robin"] as const;
export type AssignMode = (typeof ASSIGN_MODES)[number];

export const assignmentRuleSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  priority: z.number().int(),
  isActive: z.boolean(),
  matchSource: z.enum(LEAD_SOURCES).nullable(),
  matchServiceInterest: z.string().nullable(),
  matchBranchId: uuidSchema.nullable(),
  assignMode: z.enum(ASSIGN_MODES),
  assignUserId: uuidSchema.nullable(),
  poolUserIds: z.array(uuidSchema),
  lastAssignedUserId: uuidSchema.nullable(),
  matchCount: z.number().int(),
  lastMatchedAt: isoDateTime.nullable(),
});
export type AssignmentRuleDto = z.infer<typeof assignmentRuleSchema>;

const assignmentRuleBase = {
  name: shortText(120),
  /** Lower runs first. Unique per clinic, so evaluation order is deterministic. */
  priority: z.coerce.number().int().min(0).max(10_000),
  isActive: z.boolean().default(true),
  matchSource: z.enum(LEAD_SOURCES).nullish(),
  /** Case-insensitive substring of the lead's service interest. */
  matchServiceInterest: optionalShortText(200),
  matchBranchId: uuidSchema.nullish(),
  assignMode: z.enum(ASSIGN_MODES).default("user"),
  assignUserId: uuidSchema.nullish(),
  poolUserIds: z.array(uuidSchema).default([]),
};

/**
 * A rule must be able to name someone: `user` mode needs a user, `round_robin`
 * needs a non-empty pool. Without this a rule silently matches and assigns
 * nobody, which looks like the routing is broken.
 */
const assignableRefinement = (value: {
  assignMode: AssignMode;
  assignUserId?: string | null;
  poolUserIds?: string[];
}) =>
  value.assignMode === "user"
    ? Boolean(value.assignUserId)
    : (value.poolUserIds?.length ?? 0) > 0;

export const createAssignmentRuleSchema = z.object(assignmentRuleBase).refine(assignableRefinement, {
  message: "Choose someone to assign to, or add at least one person to the pool",
  path: ["assignUserId"],
});
export type CreateAssignmentRule = z.infer<typeof createAssignmentRuleSchema>;

export const updateAssignmentRuleSchema = z
  .object({
    name: shortText(120).optional(),
    priority: z.coerce.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
    matchSource: z.enum(LEAD_SOURCES).nullish(),
    matchServiceInterest: optionalShortText(200),
    matchBranchId: uuidSchema.nullish(),
    assignMode: z.enum(ASSIGN_MODES).optional(),
    assignUserId: uuidSchema.nullish(),
    poolUserIds: z.array(uuidSchema).optional(),
  })
  .refine(
    (value) =>
      // Only enforced when the mode is being set; a partial update that leaves
      // the mode alone is validated against the stored row in the service.
      value.assignMode === undefined ||
      assignableRefinement({
        assignMode: value.assignMode,
        assignUserId: value.assignUserId,
        poolUserIds: value.poolUserIds,
      }),
    { message: "Choose someone to assign to, or add at least one person to the pool", path: ["assignUserId"] },
  );
export type UpdateAssignmentRule = z.infer<typeof updateAssignmentRuleSchema>;
