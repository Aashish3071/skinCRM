import { z } from "zod";
import { isoDateTime, longText, optionalShortText, shortText, uuidSchema } from "./common";
import {
  MESSAGE_DELIVERY_STATES,
  SENDABLE_CHANNELS,
  SUPPRESSION_REASONS,
  TEMPLATE_CLASSIFICATIONS,
  WHATSAPP_TEMPLATE_STATUSES,
} from "./enums";

// --- Templates (PRD MSG-02) -----------------------------------------------

export const templateSchema = z.object({
  id: uuidSchema,
  key: z.string(),
  name: z.string(),
  channel: z.enum(SENDABLE_CHANNELS),
  classification: z.enum(TEMPLATE_CLASSIFICATIONS),
  subject: z.string().nullable(),
  body: z.string(),
  allowedVariables: z.array(z.string()),
  version: z.number().int(),
  whatsappTemplateName: z.string().nullable(),
  whatsappStatus: z.enum(WHATSAPP_TEMPLATE_STATUSES).nullable(),
  isActive: z.boolean(),
});
export type TemplateDto = z.infer<typeof templateSchema>;

export const createTemplateSchema = z.object({
  /** Stable identifier automations refer to, so renaming is safe. */
  key: z
    .string()
    .regex(/^[a-z0-9_]+$/, "Lower-case letters, numbers and underscores only")
    .max(80),
  name: shortText(120),
  channel: z.enum(SENDABLE_CHANNELS),
  /**
   * Operational or promotional. This decides which consent applies and what
   * the content must carry, so it cannot be inferred — PRD 4.4 warns that a
   * marketing email does not become operational by mentioning an appointment.
   */
  classification: z.enum(TEMPLATE_CLASSIFICATIONS),
  subject: optionalShortText(200),
  body: longText(20_000),
  whatsappTemplateName: optionalShortText(200),
  whatsappLanguageCode: optionalShortText(10),
  isActive: z.boolean().default(true),
});
export type CreateTemplate = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = createTemplateSchema.partial().omit({ key: true });
export type UpdateTemplate = z.infer<typeof updateTemplateSchema>;

export const previewTemplateSchema = z.object({
  /** Render against a real person so staff see what will actually go out. */
  personId: uuidSchema.optional(),
  appointmentId: uuidSchema.optional(),
});
export type PreviewTemplate = z.infer<typeof previewTemplateSchema>;

// --- Sending --------------------------------------------------------------

export const sendMessageSchema = z
  .object({
    personId: uuidSchema,
    leadId: uuidSchema.nullish(),
    templateKey: optionalShortText(80),
    channel: z.enum(SENDABLE_CHANNELS).optional(),
    subject: optionalShortText(200),
    body: optionalShortText(20_000),
    appointmentId: uuidSchema.nullish(),
  })
  .refine((v) => Boolean(v.templateKey) || (Boolean(v.channel) && Boolean(v.body)), {
    message: "Choose a template, or give a channel and a message body",
    path: ["templateKey"],
  });
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

// --- Delivery log (PRD MSG-07) --------------------------------------------

export const messageSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  personName: z.string().nullable(),
  leadId: uuidSchema.nullable(),
  channel: z.string(),
  direction: z.string(),
  classification: z.enum(TEMPLATE_CLASSIFICATIONS),
  templateName: z.string().nullable(),
  /** The automation that sent it, when it was not a person. */
  ruleId: uuidSchema.nullable(),
  ruleName: z.string().nullable(),
  templateVersion: z.number().int().nullable(),
  recipient: z.string().nullable(),
  renderedSubject: z.string().nullable(),
  renderedBody: z.string().nullable(),
  state: z.enum(MESSAGE_DELIVERY_STATES),
  /** Why it was not sent. Always present when the state is `suppressed`. */
  suppressionReason: z.enum(SUPPRESSION_REASONS).nullable(),
  failureDetail: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  sentAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type MessageDto = z.infer<typeof messageSchema>;

export const listMessagesQuerySchema = z.object({
  personId: uuidSchema.optional(),
  leadId: uuidSchema.optional(),
  state: z.enum(MESSAGE_DELIVERY_STATES).optional(),
  channel: z.enum(SENDABLE_CHANNELS).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/** Plain-English explanation of a suppression, for the delivery log UI. */
export const SUPPRESSION_REASON_LABELS: Record<(typeof SUPPRESSION_REASONS)[number], string> = {
  no_consent: "No consent recorded for this channel and purpose",
  opted_out: "They opted out, or the address is suppressed",
  frequency_cap: "Too many messages already sent to this person today",
  quiet_hours: "Inside the clinic's quiet hours",
  outside_service_window: "Outside WhatsApp's 24-hour window — needs an approved template",
  template_not_approved: "The template is inactive, paused or rejected",
  missing_contact_detail: "No address on file for this channel",
  lead_closed: "The inquiry is closed",
  appointment_changed: "The appointment moved or was cancelled",
  stop_condition_met: "The automation's stop condition was met",
  global_sending_disabled: "Outbound sending is switched off for this deployment",
  provider_paused: "The provider connection is paused or unavailable",
  duplicate_idempotency_key: "An equivalent message already exists",
};

export const optOutSchema = z.object({
  personId: uuidSchema,
  channel: z.enum(SENDABLE_CHANNELS),
  detail: optionalShortText(500),
});
export type OptOut = z.infer<typeof optOutSchema>;
