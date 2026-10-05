import { z } from "zod";
import { isoDateTime, longText, optionalShortText, shortText, uuidSchema } from "./common";
import { optionalNameField, phoneShapeProblem } from "./contact";
import { CONVERSATION_STATUSES, SUPPRESSION_REASONS } from "./enums";

/** Shared inbox (PRD WA-01…09). */

export const INBOX_VIEWS = ["open", "unread", "mine", "unassigned", "done"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const listConversationsQuerySchema = z.object({
  view: z.enum(INBOX_VIEWS).default("open"),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

export const conversationSummarySchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  personName: z.string(),
  tags: z.array(z.string()),
  leadId: uuidSchema.nullable(),
  status: z.enum(CONVERSATION_STATUSES),
  assignedUserId: uuidSchema.nullable(),
  assignedName: z.string().nullable(),
  lastMessageAt: isoDateTime.nullable(),
  lastPreview: z.string().nullable(),
  lastDirection: z.string().nullable(),
  unreadCount: z.number().int(),
  /** Free-form replies allowed until this instant; null when closed. */
  windowOpenUntil: isoDateTime.nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const threadItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: uuidSchema,
    direction: z.enum(["inbound", "outbound"]),
    body: z.string().nullable(),
    state: z.string(),
    suppressionReason: z.enum(SUPPRESSION_REASONS).nullable(),
    failureDetail: z.string().nullable(),
    byLabel: z.string().nullable(),
    automationName: z.string().nullable(),
    at: isoDateTime,
  }),
  z.object({
    kind: z.literal("note"),
    id: uuidSchema,
    body: z.string(),
    byLabel: z.string().nullable(),
    at: isoDateTime,
  }),
]);
export type ThreadItem = z.infer<typeof threadItemSchema>;

export const conversationDetailSchema = conversationSummarySchema.extend({
  personPhone: z.string().nullable(),
  /** Someone else is typing a reply right now. */
  replyingName: z.string().nullable(),
  items: z.array(threadItemSchema),
  nextCursor: z.object({ before: isoDateTime, beforeId: uuidSchema }).nullable(),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const replySchema = z
  .object({
    requestId: uuidSchema.optional(),
    body: optionalShortText(4_096),
    /** An approved template, for when the 24-hour window has closed. */
    templateKey: optionalShortText(80),
  })
  .refine((v) => Boolean(v.body) || Boolean(v.templateKey), { message: "Write a message first", path: ["body"] });

export const conversationNoteSchema = z.object({ body: longText(5_000) });
export const assignConversationSchema = z.object({ userId: uuidSchema.nullable() });
export const setConversationStatusSchema = z.object({ status: z.enum(["open", "resolved"]) });
export const startConversationSchema = z.object({ personId: uuidSchema });

/** Development only: pretend a patient sent a WhatsApp message (mock connector). */
export const simulateInboundSchema = z.object({
  phone: shortText(40).superRefine((value, ctx) => {
    const problem = phoneShapeProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
  name: optionalNameField(120),
  body: longText(4_096),
});
