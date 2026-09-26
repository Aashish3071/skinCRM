import { z } from "zod";
import { isoDateTime, optionalShortText, shortText, uuidSchema } from "./common";
import { INBOUND_EVENT_STATES, INBOUND_EVENT_TYPES, INTEGRATION_HEALTH_STATES, INTEGRATION_PROVIDERS } from "./enums";

/** Settings → Integrations (PRD INT-01…04, MSG-01). Secrets go in, never come out. */

export const connectMetaSchema = z.object({
  pageId: z.string().trim().regex(/^\d{5,30}$/, "A Facebook page id is a long number"),
  accessToken: shortText(1_000),
});

export const connectWhatsAppSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "The phone-number id is a long number from Meta"),
  businessAccountId: optionalShortText(40),
  displayPhone: optionalShortText(40),
  accessToken: shortText(1_000),
});

export const testSendSchema = z.object({
  channel: z.enum(["email", "whatsapp"]),
  to: shortText(200),
});

export const messagingSettingsSchema = z.object({
  promotionalSendingApproved: z.boolean().optional(),
  postalAddress: optionalShortText(300),
  sendingDomain: optionalShortText(200),
  supportEmail: optionalShortText(200),
});

export const connectionSchema = z.object({
  id: uuidSchema,
  provider: z.enum(INTEGRATION_PROVIDERS),
  status: z.enum(INTEGRATION_HEALTH_STATES),
  displayName: z.string().nullable(),
  /** Safe to show: page id or phone-number id. Never the Google key. */
  accountLabel: z.string().nullable(),
  hasSecret: z.boolean(),
  lastEventAt: isoDateTime.nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDateTime,
});
export type ConnectionDto = z.infer<typeof connectionSchema>;

export const inboundEventSchema = z.object({
  id: uuidSchema,
  type: z.enum(INBOUND_EVENT_TYPES),
  state: z.enum(INBOUND_EVENT_STATES),
  isTest: z.boolean(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  result: z.string().nullable(),
  receivedAt: isoDateTime,
});
export type InboundEventDto = z.infer<typeof inboundEventSchema>;

export interface IntegrationsOverview {
  connections: ConnectionDto[];
  events: InboundEventDto[];
  webhooks: { meta: string; whatsapp: string; google: string };
  verifyTokens: { meta: string; whatsapp: string };
  modes: { email: "mock" | "live"; whatsapp: "mock" | "live"; meta: "mock" | "live" };
  sending: {
    enabled: boolean;
    promotionalApproved: boolean;
    postalAddress: string | null;
    sendingDomain: string | null;
    supportEmail: string | null;
    emailFrom: string;
  };
}
