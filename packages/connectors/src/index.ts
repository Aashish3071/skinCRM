import { getEnv } from "@skincrm/config";
import { MockEmailConnector } from "./email/mock";
import { SmtpEmailConnector } from "./email/smtp";
import { MockWhatsAppConnector } from "./whatsapp/mock";
import type { Connectors } from "./types";

export * from "./types";
export { MockEmailConnector } from "./email/mock";
export { SmtpEmailConnector } from "./email/smtp";
export { MockWhatsAppConnector } from "./whatsapp/mock";
export { WhatsAppCloudConnector } from "./whatsapp/cloud";
export * from "./meta/leads";
export { GRAPH_BASE, GRAPH_VERSION, type FetchLike } from "./graph";

let cached: Connectors | undefined;

/**
 * Resolve the connectors for this process from `CONNECTOR_*`.
 *
 * Email `live` is SMTP (any relay; Mailpit in development). Live WhatsApp is
 * per clinic and built by the API from the clinic's encrypted connection
 * (apps/api/src/integrations/connections.ts), never silently mocked. Quietly mocking in
 * production would mean a clinic believing messages were sent when nothing left
 * the building.
 */
export function getConnectors(): Connectors {
  if (cached) return cached;
  const env = getEnv();

  cached = {
    email:
      env.CONNECTOR_EMAIL === "mock"
        ? new MockEmailConnector()
        : new SmtpEmailConnector({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            user: env.SMTP_USER,
            password: env.SMTP_PASSWORD,
          }),
    whatsapp:
      // Live WhatsApp is per clinic (its own number and token) and is built by
      // the API from the clinic's connection; this process-wide slot is the mock.
      new MockWhatsAppConnector(),
  };
  return cached;
}

/** Tests replace the whole set. */
export function setConnectors(connectors: Connectors): void {
  cached = connectors;
}

export function resetConnectors(): void {
  cached = undefined;
}

import {
  LiveMetaLeadsConnector,
  MockMetaLeadsConnector,
  type MetaLeadsConnector,
} from "./meta/leads";

let metaLeads: MetaLeadsConnector | undefined;

/** Meta Lead Ads adapter for this process, from `CONNECTOR_META`. */
export function getMetaLeadsConnector(): MetaLeadsConnector {
  metaLeads ??=
    getEnv().CONNECTOR_META === "live"
      ? new LiveMetaLeadsConnector()
      : new MockMetaLeadsConnector();
  return metaLeads;
}

export function setMetaLeadsConnector(
  connector: MetaLeadsConnector | undefined,
): void {
  metaLeads = connector;
}

export * from "./meta/capi";
export * from "./google/data-manager";
import {
  LiveMetaCapiConnector,
  MockMetaCapiConnector,
  type MetaCapiConnector,
} from "./meta/capi";
import {
  LiveGoogleFeedbackConnector,
  MockGoogleFeedbackConnector,
  type GoogleFeedbackConnector,
} from "./google/data-manager";

let capi: MetaCapiConnector | undefined;
let whatsappFeedback: MetaCapiConnector | undefined;
let googleFeedback: GoogleFeedbackConnector | undefined;

/** Conversion-feedback senders, from CONNECTOR_META / CONNECTOR_GOOGLE. */
export function getFeedbackConnectors(): {
  meta: MetaCapiConnector;
  whatsapp: MetaCapiConnector;
  google: GoogleFeedbackConnector;
} {
  const env = getEnv();
  capi ??=
    env.CONNECTOR_META === "live"
      ? new LiveMetaCapiConnector()
      : new MockMetaCapiConnector();
  googleFeedback ??=
    env.CONNECTOR_GOOGLE === "live"
      ? new LiveGoogleFeedbackConnector()
      : new MockGoogleFeedbackConnector();
  whatsappFeedback ??=
    env.CONNECTOR_WHATSAPP === "live"
      ? new LiveMetaCapiConnector()
      : new MockMetaCapiConnector();
  return { meta: capi, whatsapp: whatsappFeedback, google: googleFeedback };
}

export function setFeedbackConnectors(
  next:
    | {
        meta?: MetaCapiConnector;
        whatsapp?: MetaCapiConnector;
        google?: GoogleFeedbackConnector;
      }
    | undefined,
): void {
  capi = next?.meta;
  whatsappFeedback = next?.whatsapp ?? next?.meta;
  googleFeedback = next?.google;
}

export * from "./oauth/meta";
export * from "./oauth/google";
export * from "./oauth/whatsapp";
import { ConnectorError } from "./types";
import {
  LiveMetaOAuthClient,
  MockMetaOAuthClient,
  type MetaOAuthClient,
} from "./oauth/meta";
import {
  LiveGoogleOAuthClient,
  MockGoogleOAuthClient,
  type GoogleOAuthClient,
} from "./oauth/google";
import {
  LiveWhatsAppSignupClient,
  MockWhatsAppSignupClient,
  type WhatsAppSignupClient,
} from "./oauth/whatsapp";

let metaOAuth: MetaOAuthClient | undefined;
let googleOAuth: GoogleOAuthClient | undefined;

/**
 * "Connect with Facebook / Google" clients, from CONNECTOR_META / CONNECTOR_GOOGLE.
 * Live mode with the app credentials missing throws a message for the operator
 * rather than silently falling back to the demo flow.
 */
export function getOAuthClients(): {
  meta: MetaOAuthClient;
  google: GoogleOAuthClient;
} {
  return {
    get meta() {
      const env = getEnv();
      if (!metaOAuth) {
        if (env.CONNECTOR_META === "live") {
          if (!env.META_APP_ID || !env.META_APP_SECRET)
            throw new ConnectorError(
              "Connect with Facebook needs META_APP_ID and META_APP_SECRET on the server.",
              { retryable: false, providerCode: "not_configured" },
            );
          metaOAuth = new LiveMetaOAuthClient({
            appId: env.META_APP_ID,
            appSecret: env.META_APP_SECRET,
            loginConfigId: env.META_LOGIN_CONFIG_ID ?? null,
          });
        } else metaOAuth = new MockMetaOAuthClient();
      }
      return metaOAuth!;
    },
    get google() {
      const env = getEnv();
      if (!googleOAuth) {
        if (env.CONNECTOR_GOOGLE === "live") {
          if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET)
            throw new ConnectorError(
              "Connect with Google needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET on the server.",
              { retryable: false, providerCode: "not_configured" },
            );
          googleOAuth = new LiveGoogleOAuthClient({
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
          });
        } else googleOAuth = new MockGoogleOAuthClient();
      }
      return googleOAuth!;
    },
  };
}

/** Tests swap in fakes; undefined resets to the env-selected clients. */
export function setOAuthClients(
  next: { meta?: MetaOAuthClient; google?: GoogleOAuthClient } | undefined,
): void {
  metaOAuth = next?.meta;
  googleOAuth = next?.google;
}

let whatsappSignup: WhatsAppSignupClient | undefined;

/** WhatsApp Embedded Signup, from CONNECTOR_WHATSAPP (D-88). */
export function getWhatsAppSignupClient(): WhatsAppSignupClient {
  if (whatsappSignup) return whatsappSignup;
  const env = getEnv();
  if (env.CONNECTOR_WHATSAPP === "live") {
    if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_WA_CONFIG_ID) {
      throw new ConnectorError(
        "Connect WhatsApp needs META_APP_ID, META_APP_SECRET and META_WA_CONFIG_ID on the server.",
        { retryable: false, providerCode: "not_configured" },
      );
    }
    whatsappSignup = new LiveWhatsAppSignupClient({
      appId: env.META_APP_ID,
      appSecret: env.META_APP_SECRET,
    });
  } else whatsappSignup = new MockWhatsAppSignupClient();
  return whatsappSignup;
}

export function setWhatsAppSignupClient(
  next: WhatsAppSignupClient | undefined,
): void {
  whatsappSignup = next;
}

export * from "./meta/advertising";
import {
  LiveMetaAdvertisingClient,
  MockMetaAdvertisingClient,
  type MetaAdvertisingClient,
} from "./meta/advertising";
let advertising: MetaAdvertisingClient | undefined;
let whatsappAdvertising: MetaAdvertisingClient | undefined;
export function getMetaAdvertisingClient(
  channel: "meta" | "whatsapp" = "meta",
): MetaAdvertisingClient {
  if (channel === "whatsapp") {
    whatsappAdvertising ??=
      getEnv().CONNECTOR_WHATSAPP === "live"
        ? new LiveMetaAdvertisingClient()
        : new MockMetaAdvertisingClient();
    return whatsappAdvertising;
  }
  advertising ??=
    getEnv().CONNECTOR_META === "live"
      ? new LiveMetaAdvertisingClient()
      : new MockMetaAdvertisingClient();
  return advertising;
}
export function setMetaAdvertisingClient(
  client: MetaAdvertisingClient | undefined,
): void {
  advertising = client;
  whatsappAdvertising = client;
}
export { listWhatsAppTemplates, type WhatsAppTemplate } from "./whatsapp/templates";

export * from "./calendar/index";
import { GoogleCalendarClient, MicrosoftCalendarClient, MockCalendarClient, type CalendarClient, type CalendarProvider } from "./calendar/index";

const calendarClients = new Map<CalendarProvider, CalendarClient>();

/** Staff calendar sync clients, from CONNECTOR_CALENDAR (D-94). */
export function getCalendarClient(provider: CalendarProvider): CalendarClient {
  const existing = calendarClients.get(provider);
  if (existing) return existing;
  const env = getEnv();
  let client: CalendarClient;
  if (env.CONNECTOR_CALENDAR !== "live") client = new MockCalendarClient(provider);
  else if (provider === "google") {
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new ConnectorError("Google Calendar needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on the server.", { retryable: false, providerCode: "not_configured" });
    client = new GoogleCalendarClient({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET });
  } else {
    if (!env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) throw new ConnectorError("Outlook calendar needs MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET on the server.", { retryable: false, providerCode: "not_configured" });
    client = new MicrosoftCalendarClient({ clientId: env.MICROSOFT_OAUTH_CLIENT_ID, clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET, tenant: env.MICROSOFT_OAUTH_TENANT });
  }
  calendarClients.set(provider, client);
  return client;
}

export function setCalendarClient(provider: CalendarProvider, client: CalendarClient | undefined): void {
  if (client) calendarClients.set(provider, client);
  else calendarClients.delete(provider);
}
