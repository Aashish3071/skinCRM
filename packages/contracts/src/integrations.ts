import { z } from "zod";
import { isoDateTime, optionalShortText, shortText, uuidSchema } from "./common";
import { INBOUND_EVENT_STATES, INBOUND_EVENT_TYPES, INTEGRATION_HEALTH_STATES, INTEGRATION_PROVIDERS } from "./enums";
import { isValidEmail, optionalEmailField, optionalPhoneField, phoneShapeProblem } from "./contact";

/** Settings → Integrations (PRD INT-01…04, MSG-01). Secrets go in, never come out. */

export const connectMetaSchema = z.object({
  pageId: z.string().trim().regex(/^\d{5,30}$/, "A Facebook page id is a long number"),
  accessToken: shortText(1_000),
});

export const connectWhatsAppSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "The phone-number id is a long number from Meta"),
  businessAccountId: z.string().trim().regex(/^\d{5,30}$/, "The WhatsApp Business Account id is a long number from Meta").optional()
    .or(z.literal("").transform(() => undefined)),
  displayPhone: optionalPhoneField,
  accessToken: shortText(1_000),
});

/** "Send yourself a test": the address must match the channel. */
export const testSendSchema = z
  .object({
    channel: z.enum(["email", "whatsapp"]),
    to: shortText(200),
  })
  .superRefine((value, ctx) => {
    const problem = value.channel === "email"
      ? (isValidEmail(value.to) ? null : "Enter a full email address, like you@clinic.com.")
      : phoneShapeProblem(value.to);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["to"] });
  });

/** A domain name only, like sunshineskin.com (no https://, no @). */
const optionalDomainField = optionalShortText(200).superRefine((value, ctx) => {
  if (value !== null && !/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter just the domain, like sunshineskin.com." });
  }
});

export const messagingSettingsSchema = z.object({
  promotionalSendingApproved: z.boolean().optional(),
  postalAddress: optionalShortText(300),
  sendingDomain: optionalDomainField,
  supportEmail: optionalEmailField,
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
  /** "oauth" when made with Connect with Facebook / Google; "manual" when pasted. */
  connectedVia: z.enum(["oauth", "manual"]),
  /** Google: how many lead forms carry our webhook. */
  leadForms: z.number().int().nullable(),
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
  modes: { email: "mock" | "live"; whatsapp: "mock" | "live"; meta: "mock" | "live"; google: "mock" | "live" };
  sending: {
    enabled: boolean;
    promotionalApproved: boolean;
    postalAddress: string | null;
    sendingDomain: string | null;
    supportEmail: string | null;
    emailFrom: string;
  };
}

/** "Connect with Facebook / Google" (D-87). */
export const OAUTH_PROVIDERS = ["meta", "google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);

export const oauthCallbackSchema = z.object({
  code: z.string().min(1).max(2_000),
  state: z.string().min(20).max(200),
});

export const oauthChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  /** Why it can't be picked, when it can't. */
  unavailableReason: z.string().nullable(),
});
export type OAuthChoice = z.infer<typeof oauthChoiceSchema>;

export interface OAuthPendingDto {
  id: string;
  provider: OAuthProvider;
  choices: OAuthChoice[];
  expiresAt: string;
}

export const completeOAuthSchema = z.object({ choiceId: z.string().min(1).max(100) });

export interface OAuthCompleteResult {
  connection: ConnectionDto;
  detail: string;
}

/** WhatsApp Embedded Signup (D-88). */
export interface WhatsAppSignupStart {
  mode: "mock" | "live";
  /** Live only: what the Facebook SDK needs in the browser (both are public). */
  appId: string | null;
  configId: string | null;
  graphVersion: string;
  state: string;
}

export const completeWhatsAppSignupSchema = z.object({
  state: z.string().min(20).max(200),
  code: z.string().min(1).max(2_000),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "The phone-number id is a long number from Meta"),
  wabaId: z.string().trim().regex(/^\d{5,30}$/, "The WhatsApp Business Account id is a long number from Meta"),
  /** Kept the WhatsApp Business app on the phone (coexistence): already registered. */
  coexistence: z.boolean().default(false),
});
export type CompleteWhatsAppSignup = z.infer<typeof completeWhatsAppSignupSchema>;
