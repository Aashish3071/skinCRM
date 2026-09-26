import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clinicIdColumn, primaryId, timestamps } from "./_shared";
import {
  inboundEventStateEnum,
  inboundEventTypeEnum,
  integrationHealthStateEnum,
  integrationProviderEnum,
} from "./enums";
import { clinics, users } from "./tenancy";

/**
 * A clinic's connection to an outside account (PRD INT-01): a Facebook page
 * for Lead Ads, a WhatsApp Business number, a Google Ads lead-form key.
 *
 * `external_account_id` is how an incoming webhook finds its clinic: the page
 * id, the WhatsApp phone-number id, or a SHA-256 of the Google key (the key
 * itself is a secret and is only ever stored encrypted). It is unique per
 * provider across all clinics, so one page can never feed two clinics.
 *
 * `encrypted_secret` holds the access token or key, encrypted with the
 * clinic's key (`encryptForClinic`). It is never returned by any endpoint.
 */
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    status: integrationHealthStateEnum("status").notNull().default("connecting"),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name"),
    /** Non-secret settings, e.g. the WhatsApp business account id. */
    config: jsonb("config").$type<Record<string, string | null>>().notNull().default({}),
    encryptedSecret: text("encrypted_secret"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true, mode: "date" }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    connectedByUserId: uuid("connected_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("integration_connections_account_key").on(t.provider, t.externalAccountId),
    index("integration_connections_clinic_idx").on(t.clinicId, t.provider),
  ],
);

/**
 * Inbound provider events, queued (D-71). A webhook verifies its signature,
 * writes one row per event and answers 200 at once; the worker does the slow
 * part (fetching the lead from Meta, matching, creating). Failures retry with
 * backoff and stay visible on the Integrations screen.
 *
 * The payload is encrypted: a Google lead-form delivery carries the person's
 * name, email and phone.
 */
export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: primaryId(),
    clinicId: clinicIdColumn().references(() => clinics.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => integrationConnections.id, { onDelete: "set null" }),
    type: inboundEventTypeEnum("type").notNull(),
    /** The provider's id for the event, for idempotency. */
    externalId: text("external_id").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    isTest: integer("is_test").notNull().default(0),
    state: inboundEventStateEnum("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    /** What it became, e.g. `lead:<id>` or `duplicate`. */
    result: text("result"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("inbound_events_external_key").on(t.clinicId, t.type, t.externalId),
    index("inbound_events_due_idx").on(t.nextAttemptAt).where(sql`${t.state} = 'pending'`),
    index("inbound_events_clinic_idx").on(t.clinicId, t.receivedAt),
  ],
);

export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type InboundEvent = typeof inboundEvents.$inferSelect;
