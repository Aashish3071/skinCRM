import { z } from "zod";
import { isoDate, isoDateTime, queryBoolean, uuidSchema } from "./common";
import type { ActivityType } from "./enums";

/**
 * The clinic-wide Notes and Activity sections: every patient's notes, and
 * everything that happened, in one place — so a doctor does not have to open
 * patients one by one to catch up.
 */

const dateRange = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

export const listNotesQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  personId: uuidSchema.optional(),
  ...dateRange,
  pinned: queryBoolean(false),
  mine: queryBoolean(false),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  path: ["to"], message: "End date must be on or after start date",
});

export const noteFeedItemSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  personName: z.string(),
  body: z.string(),
  pinned: z.boolean(),
  authorLabel: z.string().nullable(),
  isMine: z.boolean(),
  createdAt: isoDateTime,
  editedAt: isoDateTime.nullable(),
});
export type NoteFeedItem = z.infer<typeof noteFeedItemSchema>;

/** Plain groups for the Activity filter, instead of eighteen raw types. */
export const ACTIVITY_GROUPS = {
  calls: { label: "Calls", types: ["call"] },
  messages: {
    label: "Messages",
    types: ["email_sent", "email_received", "whatsapp_sent", "whatsapp_received"],
  },
  appointments: { label: "Appointments", types: ["appointment_created", "appointment_changed"] },
  notes: { label: "Notes", types: ["note"] },
  progress: { label: "Lead progress", types: ["stage_change", "assignment_change", "source_submission", "merge"] },
  tasks: { label: "Tasks", types: ["task_created", "task_completed"] },
} as const satisfies Record<string, { label: string; types: readonly ActivityType[] }>;
export type ActivityGroup = keyof typeof ACTIVITY_GROUPS;

export const listActivityQuerySchema = z.object({
  personId: uuidSchema.optional(),
  ...dateRange,
  group: z.enum(Object.keys(ACTIVITY_GROUPS) as [ActivityGroup, ...ActivityGroup[]]).optional(),
  /** Only things the signed-in user did. */
  mine: queryBoolean(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  path: ["to"], message: "End date must be on or after start date",
});

export const activityFeedItemSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  personName: z.string(),
  leadId: uuidSchema.nullable(),
  leadCreatedAt: isoDateTime.nullable(),
  type: z.string(),
  summary: z.string(),
  body: z.string().nullable(),
  actorLabel: z.string().nullable(),
  isMine: z.boolean(),
  occurredAt: isoDateTime,
});
export type ActivityFeedItem = z.infer<typeof activityFeedItemSchema>;
