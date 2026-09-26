import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@skincrm/db";
import { verifyUnsubscribeToken } from "@skincrm/security";
import { getTx } from "../context";
import { notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { runAsSystem } from "../automations/system-context";

const { clinics, consentRecords, people } = schema;

/**
 * Public unsubscribe (PRD MSG-04, CAN-SPAM).
 *
 * No login: the signed token is the authority, and it can only ever do one
 * thing — stop marketing on one channel for one person. It withdraws
 * *promotional* consent rather than suppressing the address outright, so the
 * person still gets their appointment reminders; that is what unsubscribing
 * from a marketing email means.
 *
 * The response names the clinic and nothing about the person, because anyone
 * holding a forwarded email holds the link.
 */
export function registerUnsubscribeRoutes(app: FastifyInstance): void {
  const params = z.object({ token: z.string().min(10).max(600) });

  registerRoute(app, {
    method: "GET",
    url: "/public/unsubscribe/:token",
    auth: false,
    params,
    rateLimit: { max: 60, timeWindow: "1 minute" },
    handler: async ({ params }) => {
      const payload = verifyOrThrow(params.token);
      return runAsSystem(payload.clinicId, async () => {
        const clinic = await getTx().select({ name: clinics.name }).from(clinics).limit(1);
        return {
          clinicName: clinic[0]?.name ?? "the clinic",
          channel: payload.channel,
          unsubscribed: (await latestPromotionalStatus(payload.personId, payload.channel)) === "withdrawn",
        };
      });
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/public/unsubscribe/:token",
    auth: false,
    params,
    rateLimit: { max: 30, timeWindow: "1 minute" },
    handler: async ({ params }) => {
      const payload = verifyOrThrow(params.token);
      await runAsSystem(payload.clinicId, async () => {
        const tx = getTx();
        const person = await tx.select({ id: people.id }).from(people).where(eq(people.id, payload.personId)).limit(1);
        if (!person[0]) throw notFound("This link is no longer valid.");
        // Idempotent: a second click records nothing new.
        if ((await latestPromotionalStatus(payload.personId, payload.channel)) === "withdrawn") return;

        await tx.insert(consentRecords).values({
          clinicId: payload.clinicId,
          personId: payload.personId,
          channel: payload.channel as "email" | "whatsapp",
          purpose: "promotional",
          status: "withdrawn",
          source: "unsubscribe_link",
          capturedText: "Unsubscribed using the link in a message",
        });
        await recordAudit({
          action: "consent_changed",
          entityType: "person",
          entityId: payload.personId,
          changeSummary: { promotional: "withdrawn", channel: payload.channel, via: "unsubscribe_link" },
        });
      });
      return { unsubscribed: true };
    },
  });
}

function verifyOrThrow(token: string) {
  const payload = verifyUnsubscribeToken(token);
  if (!payload || (payload.channel !== "email" && payload.channel !== "whatsapp")) {
    throw notFound("This link is no longer valid.");
  }
  return payload;
}

async function latestPromotionalStatus(personId: string, channel: string) {
  const rows = await getTx()
    .select({ status: consentRecords.status })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.personId, personId),
        eq(consentRecords.channel, channel as "email" | "whatsapp"),
        eq(consentRecords.purpose, "promotional"),
      ),
    )
    .orderBy(desc(consentRecords.occurredAt))
    .limit(1);
  return rows[0]?.status ?? null;
}
