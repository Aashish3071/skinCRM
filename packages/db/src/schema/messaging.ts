import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { archivedAt, clinicIdColumn, primaryId, timestamps } from "./_shared";
import {
  contactChannelEnum,
  messageDeliveryStateEnum,
  messageDirectionEnum,
  suppressionReasonEnum,
  templateClassificationEnum,
  whatsappTemplateStatusEnum,
} from "./enums";
import { clinics, users } from "./tenancy";
import { leads } from "./leads";
import { people } from "./people";

/**
 * Message templates (PRD MSG-02).
 *
 * `classification` is the load-bearing field. An operational message (an
 * appointment confirmation) and a promotional one (a nurture offer) have
 * different legal bases, different consent, and different content
 * requirements. PRD 4.4 is explicit that a marketing email does not become
 * operational merely by mentioning an appointment, so the clinic classifies it
 * and the send gate enforces the consequences.
 */
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    channel: contactChannelEnum("channel").notNull(),
    classification: templateClassificationEnum("classification").notNull(),

    /** Email only. Kept generic: no service or condition in a subject line (PRD 8). */
    subject: text("subject"),
    body: text("body").notNull(),

    /**
     * Variables the body may reference. A body using anything outside this list
     * fails validation rather than rendering an empty gap at send time.
     */
    allowedVariables: jsonb("allowed_variables").$type<string[]>().notNull().default([]),

    /**
     * Bumped on every content change. The rendered message stores the version it
     * was produced from, so a delivery log entry can always be explained even
     * after the template moves on (PRD MSG-02).
     */
    version: integer("version").notNull().default(1),

    /** WhatsApp only: the provider-side template name and its approval state. */
    whatsappTemplateName: text("whatsapp_template_name"),
    whatsappLanguageCode: text("whatsapp_language_code").default("en"),
    whatsappStatus: whatsappTemplateStatusEnum("whatsapp_status"),

    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (t) => [
    uniqueIndex("message_templates_clinic_key").on(t.clinicId, t.key),
    index("message_templates_clinic_channel_idx").on(t.clinicId, t.channel, t.isActive),
  ],
);

/**
 * The delivery log (PRD MSG-07): every message the CRM sent, tried to send, or
 * deliberately did not send.
 *
 * A blocked message is recorded with a `suppression_reason`, never dropped
 * silently — "why did my client not get the reminder" has to be answerable.
 */
export const messages = pgTable(
  "messages",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),

    channel: contactChannelEnum("channel").notNull(),
    direction: messageDirectionEnum("direction").notNull().default("outbound"),
    classification: templateClassificationEnum("classification").notNull(),

    templateId: uuid("template_id").references(() => messageTemplates.id, { onDelete: "set null" }),
    /** The version actually rendered, so history stays explainable. */
    templateVersion: integer("template_version"),

    /** Where it went. Stored to answer "which address did we use". */
    recipient: text("recipient"),
    renderedSubject: text("rendered_subject"),
    /** May contain personal context; excluded from logs and ad payloads. */
    renderedBody: text("rendered_body"),

    state: messageDeliveryStateEnum("state").notNull().default("draft"),
    suppressionReason: suppressionReasonEnum("suppression_reason"),
    /** Provider or internal detail. Never the message body. */
    failureDetail: text("failure_detail"),

    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),

    /**
     * Derived from person + rule + trigger + schedule instance + channel
     * (PRD MSG-05). The unique index is what actually makes a replayed job or a
     * redelivered webhook unable to send twice.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    /** The inbox thread it belongs to (WhatsApp). Plain uuid: avoids a schema import cycle. */
    conversationId: uuid("conversation_id"),

    /** Which automation produced it, when it was not a person clicking send. */
    ruleId: uuid("rule_id"),
    triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("messages_idempotency_key").on(t.clinicId, t.idempotencyKey),
    index("messages_person_idx").on(t.personId, t.createdAt),
    index("messages_clinic_state_idx").on(t.clinicId, t.state),
    index("messages_scheduled_idx").on(t.scheduledFor),
    index("messages_provider_idx").on(t.providerMessageId),
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
  ],
);

/**
 * Hard suppressions (PRD MSG-04, MSG-05).
 *
 * Separate from the consent ledger: consent is what the person agreed to, this
 * is what the provider or the person told us afterwards — a hard bounce, a spam
 * complaint, an unsubscribe click. Either one blocks a send, and mixing them
 * would lose the distinction between "never agreed" and "agreed then bounced".
 */
export const suppressions = pgTable(
  "suppressions",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    channel: contactChannelEnum("channel").notNull(),
    /** Normalized address or wa_id, so it survives the person record changing. */
    destination: text("destination").notNull(),
    reason: suppressionReasonEnum("reason").notNull(),
    detail: text("detail"),
    /** Null means indefinite. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamps().createdAt,
  },
  (t) => [
    uniqueIndex("suppressions_destination_key").on(t.clinicId, t.channel, t.destination),
    index("suppressions_person_idx").on(t.personId),
  ],
);

export const messageTemplatesRelations = relations(messageTemplates, ({ one, many }) => ({
  clinic: one(clinics, { fields: [messageTemplates.clinicId], references: [clinics.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  person: one(people, { fields: [messages.personId], references: [people.id] }),
  lead: one(leads, { fields: [messages.leadId], references: [leads.id] }),
  template: one(messageTemplates, {
    fields: [messages.templateId],
    references: [messageTemplates.id],
  }),
}));

export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;

/** Committed independently before contacting a provider. No patient/message FK:
 * the surrounding CRM transaction may still be uncommitted or roll back. */
export const deliveryAttempts = pgTable("delivery_attempts", {
  id: primaryId(),
  clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  payloadEncrypted: text("payload_encrypted"),
  personId: uuid("person_id").notNull(),
  channel: text("channel").notNull(),
  state: text("state").notNull().default("uncertain"),
  providerMessageId: text("provider_message_id"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
  detail: text("detail"),
  retryable: boolean("retryable").notNull().default(false),
  permanentSuppression: boolean("permanent_suppression").notNull().default(false),
  ...timestamps(),
}, (t) => [uniqueIndex("delivery_attempts_key").on(t.clinicId, t.idempotencyKey)]);
