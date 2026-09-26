import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTemplateSchema,
  listMessagesQuerySchema,
  optOutSchema,
  previewTemplateSchema,
  sendMessageSchema,
  updateTemplateSchema,
  uuidSchema,
  type MessageDto,
  type TemplateDto,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { buildIdempotencyKey } from "@skincrm/security";
import { getConnectors } from "@skincrm/connectors";
import { getContext, getTx } from "../context";
import { badRequest, conflict, notFound } from "../errors";
import { diffSummary, recordAudit } from "../audit";
import { registerRoute } from "../route";
import { getPerson } from "../people/service";
import { recordOptOut, sendMessage } from "./service";
import {
  ALL_TEMPLATE_VARIABLE_NAMES,
  TEMPLATE_VARIABLES,
  renderTemplate,
  validateTemplateBody,
} from "./render";

const { messageTemplates, messages, people, suppressions } = schema;

export function registerMessagingRoutes(app: FastifyInstance): void {
  // --- Available variables -------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/templates/variables",
    auth: { capability: "templates:read" },
    handler: async () => ({
      items: Object.entries(TEMPLATE_VARIABLES).map(([name, description]) => ({
        name,
        description,
      })),
    }),
  });

  // --- Templates (PRD MSG-02) ---------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/templates",
    auth: { capability: "templates:read" },
    handler: async () => {
      const tx = getTx();
      const rows = await tx
        .select()
        .from(messageTemplates)
        .where(isNull(messageTemplates.archivedAt))
        .orderBy(desc(messageTemplates.updatedAt));
      return { items: rows.map(serializeTemplate) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/templates",
    auth: { capability: "templates:write" },
    body: createTemplateSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();

      assertBodyIsRenderable(body.body, body.subject ?? null);
      assertPromotionalRequirements(body.classification, body.channel, body.body);

      const existing = await tx
        .select({ id: messageTemplates.id })
        .from(messageTemplates)
        .where(eq(messageTemplates.key, body.key))
        .limit(1);
      if (existing[0]) throw conflict(`A template with key "${body.key}" already exists.`);

      const inserted = await tx
        .insert(messageTemplates)
        .values({
          clinicId: context.clinicId!,
          key: body.key,
          name: body.name,
          channel: body.channel,
          classification: body.classification,
          subject: body.subject ?? null,
          body: body.body,
          allowedVariables: ALL_TEMPLATE_VARIABLE_NAMES,
          whatsappTemplateName: body.whatsappTemplateName ?? null,
          whatsappLanguageCode: body.whatsappLanguageCode ?? "en",
          // A WhatsApp template starts unapproved: Meta approves it, not us.
          whatsappStatus: body.channel === "whatsapp" ? "draft" : null,
          isActive: body.isActive,
        })
        .returning();

      await recordAudit({
        action: "template_changed",
        entityType: "message_template",
        entityId: inserted[0]!.id,
        changeSummary: { created: body.key, classification: body.classification },
      });
      return serializeTemplate(inserted[0]!);
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/templates/:id",
    auth: { capability: "templates:write" },
    params: z.object({ id: uuidSchema }),
    body: updateTemplateSchema,
    handler: async ({ params, body }) => {
      const tx = getTx();
      const before = await loadTemplateRow(params.id);

      const nextBody = body.body ?? before.body;
      const nextSubject = body.subject !== undefined ? body.subject : before.subject;
      const nextClassification = body.classification ?? before.classification;
      const nextChannel = body.channel ?? before.channel;

      assertBodyIsRenderable(nextBody, nextSubject);
      assertPromotionalRequirements(nextClassification, nextChannel, nextBody);

      const contentChanged = body.body !== undefined || body.subject !== undefined;
      const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
      if (contentChanged) {
        // Bump the version so every already-sent message can still be
        // explained against the text it was actually rendered from.
        updates.version = before.version + 1;
        if (before.channel === "whatsapp") {
          // Editing the copy invalidates Meta's approval.
          updates.whatsappStatus = "draft";
        }
      }

      const updated = await tx
        .update(messageTemplates)
        .set(updates)
        .where(eq(messageTemplates.id, params.id))
        .returning();

      await recordAudit({
        action: "template_changed",
        entityType: "message_template",
        entityId: params.id,
        changeSummary: diffSummary(before as unknown as Record<string, unknown>, updates),
      });
      return serializeTemplate(updated[0]!);
    },
  });

  /** Preview against a real person, so staff see what will actually go out. */
  registerRoute(app, {
    method: "POST",
    url: "/templates/:id/preview",
    auth: { capability: "templates:read" },
    params: z.object({ id: uuidSchema }),
    body: previewTemplateSchema,
    status: 200,
    handler: async ({ params, body }) => {
      const template = await loadTemplateRow(params.id);
      const sample = await sampleVariables(body.personId ?? null);

      const renderedBody = renderTemplate(template.body, sample);
      const renderedSubject = template.subject ? renderTemplate(template.subject, sample) : null;

      return {
        subject: renderedSubject?.text ?? null,
        body: renderedBody.text,
        // Surfaced so the gap is fixed before a client ever sees it.
        missingVariables: [...new Set([...renderedBody.missing, ...(renderedSubject?.missing ?? [])])],
        classification: template.classification,
      };
    },
  });

  // --- Send ----------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/messages",
    auth: { capability: "messages:send" },
    body: sendMessageSchema,
    status: 200,
    handler: async ({ body }) => {
      const context = getContext();
      await getPerson(body.personId);

      const outcome = await sendMessage({
        personId: body.personId,
        leadId: body.leadId ?? null,
        templateKey: body.templateKey ?? undefined,
        adHoc: body.templateKey
          ? undefined
          : { channel: body.channel!, subject: body.subject ?? undefined, body: body.body! },
        appointmentId: body.appointmentId ?? null,
        // A staff-initiated send is one deliberate action; the key ties it to
        // this request so a double-click cannot send twice.
        idempotencyKey: buildIdempotencyKey({
          clinicId: context.clinicId!,
          personId: body.personId,
          ruleId: null,
          triggerEventId: context.correlationId,
          scheduleInstance: null,
          channel: body.channel ?? body.templateKey ?? "unknown",
        }),
      });

      return outcome;
    },
  });

  // --- Delivery log (PRD MSG-07) ------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/messages",
    auth: { capability: "templates:read" },
    query: listMessagesQuerySchema,
    handler: async ({ query }) => {
      const tx = getTx();
      const conditions = [];
      if (query.personId) conditions.push(eq(messages.personId, query.personId));
      if (query.leadId) conditions.push(eq(messages.leadId, query.leadId));
      if (query.state) conditions.push(eq(messages.state, query.state));
      if (query.channel) conditions.push(eq(messages.channel, query.channel));

      const rows = await tx
        .select({
          message: messages,
          personName: people.displayName,
          templateName: messageTemplates.name,
        })
        .from(messages)
        .leftJoin(people, eq(people.id, messages.personId))
        .leftJoin(messageTemplates, eq(messageTemplates.id, messages.templateId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(messages.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      const totals = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(messages)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return { items: rows.map(serializeMessage), totalCount: totals[0]?.total ?? 0 };
    },
  });

  // --- Opt-out and suppressions (PRD MSG-04) ------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/messages/opt-out",
    auth: { capability: "consent:write" },
    body: optOutSchema,
    status: 204,
    handler: async ({ body }) => {
      const tx = getTx();
      const person = await getPerson(body.personId);
      const destination =
        body.channel === "email" ? person.emailNormalized : person.phoneE164?.replace(/^\+/, "");
      if (!destination) throw badRequest(`That person has no ${body.channel} address on file.`);

      await recordOptOut({
        personId: person.id,
        channel: body.channel,
        destination,
        detail: body.detail ?? undefined,
      });
      void tx;
      return null;
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/suppressions",
    auth: { capability: "consent:read" },
    handler: async () => {
      const tx = getTx();
      const rows = await tx
        .select()
        .from(suppressions)
        .orderBy(desc(suppressions.createdAt))
        .limit(200);
      return {
        items: rows.map((row) => ({
          id: row.id,
          personId: row.personId,
          channel: row.channel,
          destination: row.destination,
          reason: row.reason,
          detail: row.detail,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  });

  // --- Connector health (PRD INT-01) --------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/integrations/messaging/health",
    auth: { capability: "integrations:read" },
    handler: async () => {
      const connectors = getConnectors();
      const [email, whatsapp] = await Promise.all([
        connectors.email.verify(),
        connectors.whatsapp.verify(),
      ]);
      return {
        email: { mode: connectors.email.mode, ...email },
        whatsapp: { mode: connectors.whatsapp.mode, ...whatsapp },
      };
    },
  });
}

// --- Helpers --------------------------------------------------------------

async function loadTemplateRow(id: string) {
  const tx = getTx();
  const rows = await tx
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("No such template.");
  return row;
}

/** Reject a template that references a variable the product does not offer. */
function assertBodyIsRenderable(body: string, subject: string | null): void {
  const bodyCheck = validateTemplateBody(body, ALL_TEMPLATE_VARIABLE_NAMES);
  const subjectCheck = subject
    ? validateTemplateBody(subject, ALL_TEMPLATE_VARIABLE_NAMES)
    : { valid: true, unknownVariables: [] as string[] };

  const unknown = [...bodyCheck.unknownVariables, ...subjectCheck.unknownVariables];
  if (unknown.length > 0) {
    throw badRequest(
      `Unknown variables: ${unknown.join(", ")}. See the variable list for what is available.`,
      { body: unknown.map((v) => `{{${v}}} is not a variable you can use`) },
    );
  }
}

/**
 * CAN-SPAM requirements for promotional email (PRD 4.4).
 *
 * Checked when the template is saved, not at send time, so the clinic finds
 * out while editing rather than through a suppressed send.
 */
function assertPromotionalRequirements(
  classification: string,
  channel: string,
  body: string,
): void {
  if (classification !== "promotional" || channel !== "email") return;

  if (!body.includes("{{link.unsubscribe}}")) {
    throw badRequest(
      "Promotional email must include an unsubscribe link. Add {{link.unsubscribe}} to the body.",
      { body: ["Missing {{link.unsubscribe}}"] },
    );
  }
  if (!body.includes("{{clinic.address}}")) {
    throw badRequest(
      "Promotional email must show the clinic's postal address. Add {{clinic.address}} to the body.",
      { body: ["Missing {{clinic.address}}"] },
    );
  }
}

async function sampleVariables(personId: string | null): Promise<Record<string, string | null>> {
  const tx = getTx();
  const base: Record<string, string | null> = {
    "person.firstName": "Sample",
    "person.fullName": "Sample Client",
    "clinic.name": "Your clinic",
    "clinic.phone": "—",
    "clinic.address": "—",
    "appointment.date": "Monday, 5 October 2026",
    "appointment.time": "10:00 AM",
    "appointment.staffName": "Dr. Sample",
    "link.unsubscribe": "https://example.test/unsubscribe/sample",
    "link.reschedule": "https://example.test/reschedule/sample",
  };

  if (personId) {
    const rows = await tx
      .select({ firstName: people.firstName, displayName: people.displayName })
      .from(people)
      .where(eq(people.id, personId))
      .limit(1);
    if (rows[0]) {
      base["person.firstName"] = rows[0].firstName ?? rows[0].displayName.split(" ")[0] ?? null;
      base["person.fullName"] = rows[0].displayName;
    }
  }
  return base;
}

function serializeTemplate(row: typeof messageTemplates.$inferSelect): TemplateDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    channel: row.channel as TemplateDto["channel"],
    classification: row.classification,
    subject: row.subject,
    body: row.body,
    allowedVariables: row.allowedVariables ?? [],
    version: row.version,
    whatsappTemplateName: row.whatsappTemplateName,
    whatsappStatus: row.whatsappStatus,
    isActive: row.isActive,
  };
}

function serializeMessage(row: {
  message: typeof messages.$inferSelect;
  personName: string | null;
  templateName: string | null;
}): MessageDto {
  const m = row.message;
  return {
    id: m.id,
    personId: m.personId,
    personName: row.personName,
    leadId: m.leadId,
    channel: m.channel,
    direction: m.direction,
    classification: m.classification,
    templateName: row.templateName,
    templateVersion: m.templateVersion,
    recipient: m.recipient,
    renderedSubject: m.renderedSubject,
    renderedBody: m.renderedBody,
    state: m.state,
    suppressionReason: m.suppressionReason,
    failureDetail: m.failureDetail,
    providerMessageId: m.providerMessageId,
    sentAt: m.sentAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}
