import { z } from "zod";
import { isoDateTime, optionalShortText, shortText, uuidSchema } from "./common";
import {
  FEEDBACK_DESTINATIONS,
  FEEDBACK_ELIGIBILITY_STATES,
  FEEDBACK_EVENT_STATES,
  FEEDBACK_MILESTONES,
  type FeedbackMilestone,
} from "./enums";

/**
 * Conversion feedback (PRD 4.5a, FB-01…10): telling Meta or Google that a lead
 * from their ad reached a milestone, so the clinic's campaigns can learn from
 * outcomes instead of raw lead counts. Off until each destination is reviewed.
 */

export const FEEDBACK_MILESTONE_LABELS: Record<FeedbackMilestone, { title: string; hint: string }> = {
  qualified: { title: "Qualified", hint: "Booked an appointment (the same moment as Booked — map one, not both)" },
  consultation_booked: { title: "Booked", hint: "An appointment was booked" },
  consultation_attended: { title: "Visited", hint: "Came to the appointment" },
  converted: { title: "Won", hint: "Became a paying client" },
};

/**
 * Words that would disclose a health relationship in an event name (PRD 4.5a:
 * "screen event names … for sensitive health information"). Event names must
 * describe the funnel step, never the service.
 */
export const FORBIDDEN_EVENT_WORDS = [
  "acne", "botox", "filler", "laser", "derm", "skin", "facial", "peel", "inject", "treat", "therap", "surgery",
  "cosmetic", "aesthetic", "medical", "health", "patient", "clinic", "diagnos", "condition", "weight", "hair", "tattoo",
  "scar", "wrinkle", "lip", "breast", "body",
];

export function forbiddenWordIn(name: string): string | null {
  const lower = name.toLowerCase();
  return FORBIDDEN_EVENT_WORDS.find((w) => lower.includes(w)) ?? null;
}

const eventName = z
  .string()
  .trim()
  .min(1, "Name the event")
  .max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_ ]*$/, "Letters, numbers, spaces and underscores only")
  .superRefine((v, ctx) => {
    const word = forbiddenWordIn(v);
    if (word) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Event names can't mention services or health (“${word}”). Use a funnel word like “QualifiedLead”.` });
  });

export const mappingEntrySchema = z.object({
  enabled: z.boolean(),
  whatsappEventName: z.enum(["LeadSubmitted", "ViewContent"]).default("LeadSubmitted"),
  /** Meta: the event name. Google: a label shown here (Google uses the conversion action). */
  eventName: eventName,
  /** Google only: the conversion action to report into. */
  conversionCustomerId: z.string().regex(/^\d*$/).max(30).default(""),
  conversionActionId: z.string().trim().regex(/^\d*$/, "Numbers only").max(30).optional().default(""),
});

export const feedbackMappingSchema = z.object(
  Object.fromEntries(FEEDBACK_MILESTONES.map((m) => [m, mappingEntrySchema])) as Record<FeedbackMilestone, typeof mappingEntrySchema>,
);
export type FeedbackMapping = z.infer<typeof feedbackMappingSchema>;

export const DEFAULT_FEEDBACK_MAPPING: FeedbackMapping = {
  qualified: { enabled: false, eventName: "QualifiedLead", conversionActionId: "", whatsappEventName: "LeadSubmitted", conversionCustomerId: "" },
  consultation_booked: { enabled: false, eventName: "BookedLead", conversionActionId: "", whatsappEventName: "LeadSubmitted", conversionCustomerId: "" },
  consultation_attended: { enabled: false, eventName: "AttendedLead", conversionActionId: "", whatsappEventName: "LeadSubmitted", conversionCustomerId: "" },
  converted: { enabled: false, eventName: "ConvertedLead", conversionActionId: "", whatsappEventName: "LeadSubmitted", conversionCustomerId: "" },
};

export const saveFeedbackSettingsSchema = z.object({
  mapping: feedbackMappingSchema,
  /** Meta only: WhatsApp-ad outcomes are a separate mapping Meta must validate (FB-09). */
  includeWhatsAppAds: z.boolean().default(false),
});

export const feedbackChecklistSchema = z.object({
  privacyApproved: z.literal(true, { errorMap: () => ({ message: "Needed before testing" }) }),
  policyChecked: z.literal(true, { errorMap: () => ({ message: "Needed before testing" }) }),
  dataUnderstood: z.literal(true, { errorMap: () => ({ message: "Needed before testing" }) }),
});

export const connectMetaCapiSchema = z.object({
  datasetId: z.string().trim().regex(/^\d{5,30}$/, "The dataset (pixel) ID is a long number"),
  accessToken: shortText(1_000),
  testEventCode: optionalShortText(40),
  whatsappDatasetId: z.string().trim().regex(/^\d{5,30}$/).optional().or(z.literal("")),
  whatsappBusinessAccountId: z.string().trim().regex(/^\d{5,30}$/).optional().or(z.literal("")),
});

export const connectGoogleFeedbackSchema = z.object({
  customerId: z.string().trim().regex(/^\d{3}-?\d{3}-?\d{4}$/, "Google Ads customer ID, like 123-456-7890"),
  clientId: shortText(300),
  clientSecret: shortText(300),
  refreshToken: shortText(1_000),
  loginCustomerId: optionalShortText(20),
});

export const feedbackDestinationSchema = z.object({
  destination: z.enum(FEEDBACK_DESTINATIONS),
  connected: z.boolean(),
  accountLabel: z.string().nullable(),
  eligibility: z.enum(FEEDBACK_ELIGIBILITY_STATES),
  paused: z.boolean(),
  mapping: feedbackMappingSchema,
  mappingVersion: z.number().int(),
  includeWhatsAppAds: z.boolean(),
  checklistConfirmedBy: z.string().nullable(),
  checklistConfirmedAt: isoDateTime.nullable(),
  lastTestAt: isoDateTime.nullable(),
  lastTestOk: z.boolean().nullable(),
  lastTestDetail: z.string().nullable(),
  hasTestEventCode: z.boolean(),
  whatsappConnected: z.boolean(),
  whatsappDatasetId: z.string().nullable(),
  whatsappBusinessAccountId: z.string().nullable(),
  whatsappTestOk: z.boolean().nullable(),
});
export type FeedbackDestinationDto = z.infer<typeof feedbackDestinationSchema>;

export const feedbackEventSchema = z.object({
  id: uuidSchema,
  destination: z.enum(FEEDBACK_DESTINATIONS),
  milestone: z.enum(FEEDBACK_MILESTONES),
  leadId: uuidSchema,
  personName: z.string().nullable(),
  state: z.enum(FEEDBACK_EVENT_STATES),
  reason: z.string().nullable(),
  testMode: z.boolean(),
  attempts: z.number().int(),
  eventTime: isoDateTime,
  sentAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type FeedbackEventDto = z.infer<typeof feedbackEventSchema>;

/** What would be sent, with identifiers masked (FB-04). */
export interface FeedbackPreview {
  destination: string;
  milestone: FeedbackMilestone;
  eventName: string;
  eventTime: string;
  eventId: string;
  identifiers: Record<string, string>;
  payload: unknown;
  mode: "test" | "production";
}

export interface FeedbackAssets {
  metaDatasets: { id: string; name: string; businessName: string }[];
  googleActions: { id: string; name: string; ownerCustomerId: string }[];
  metaConnected: boolean;
  whatsappConnected: boolean;
  googleConnected: boolean;
  errors: { channel: "meta" | "google"; message: string }[];
}
