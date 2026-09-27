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

import { LiveMetaLeadsConnector, MockMetaLeadsConnector, type MetaLeadsConnector } from "./meta/leads";

let metaLeads: MetaLeadsConnector | undefined;

/** Meta Lead Ads adapter for this process, from `CONNECTOR_META`. */
export function getMetaLeadsConnector(): MetaLeadsConnector {
  metaLeads ??= getEnv().CONNECTOR_META === "live" ? new LiveMetaLeadsConnector() : new MockMetaLeadsConnector();
  return metaLeads;
}

export function setMetaLeadsConnector(connector: MetaLeadsConnector | undefined): void {
  metaLeads = connector;
}

export * from "./meta/capi";
export * from "./google/data-manager";
import { LiveMetaCapiConnector, MockMetaCapiConnector, type MetaCapiConnector } from "./meta/capi";
import { LiveGoogleFeedbackConnector, MockGoogleFeedbackConnector, type GoogleFeedbackConnector } from "./google/data-manager";

let capi: MetaCapiConnector | undefined;
let googleFeedback: GoogleFeedbackConnector | undefined;

/** Conversion-feedback senders, from CONNECTOR_META / CONNECTOR_GOOGLE. */
export function getFeedbackConnectors(): { meta: MetaCapiConnector; google: GoogleFeedbackConnector } {
  const env = getEnv();
  capi ??= env.CONNECTOR_META === "live" ? new LiveMetaCapiConnector() : new MockMetaCapiConnector();
  googleFeedback ??= env.CONNECTOR_GOOGLE === "live" ? new LiveGoogleFeedbackConnector() : new MockGoogleFeedbackConnector();
  return { meta: capi, google: googleFeedback };
}

export function setFeedbackConnectors(next: { meta?: MetaCapiConnector; google?: GoogleFeedbackConnector } | undefined): void {
  capi = next?.meta;
  googleFeedback = next?.google;
}
