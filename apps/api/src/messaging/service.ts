import { getEnv } from "@skincrm/config";
import { refreshTemplateApproval } from "./whatsapp-templates";
import { deliverOnce } from "./delivery";
import { and, desc, eq } from "drizzle-orm";
import type { SendableChannel, TemplateClassification } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { ConnectorError, getConnectors } from "@skincrm/connectors";
import { unsubscribeUrl } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { logger } from "../logger";
import { recordAudit } from "../audit";
import { addActivity } from "../leads/service";
import { evaluateSend, resolveDestination } from "./send-gate";
import { extractVariables, renderTemplate } from "./render";
import { whatsappConnector } from "../integrations/connections";
import { ensureConversation, touchConversation } from "../inbox/store";
import { markFirstResponse } from "../leads/sla";

const { messages, messageTemplates, people, clinics, appointments, users, suppressions } = schema;

export interface SendRequest {
  personId: string;
  leadId?: string | null;
  templateKey?: string;
  /** For an ad-hoc staff message with no template behind it. */
  adHoc?: {
    channel: SendableChannel;
    subject?: string;
    body: string;
    /**
     * Defaults to operational: a staff member replying to a client. An
     * automation writing its own copy must say which it is, because a
     * promotional message needs promotional consent (PRD 4.4).
     */
    classification?: TemplateClassification;
  };
  /** Extra variables beyond the ones resolved from the person and clinic. */
  variables?: Record<string, string | null>;
  appointmentId?: string | null;
  idempotencyKey: string;
  ruleId?: string | null;
  ignoreQuietHours?: boolean;
  /** Who is replying from the inbox, for the thread's "sent by". */
  conversationId?: string | null;
}

export interface SendOutcome {
  messageId: string;
  state: "sent" | "suppressed" | "failed";
  suppressionReason?: string;
  detail?: string;
  /** For a failure: whether trying again later could succeed. */
  retryable?: boolean;
}

/**
 * Send one message, or record exactly why it was not sent.
 *
 * Always writes a row to the delivery log, whatever the outcome (PRD MSG-07).
 * A message that never went out is a fact the clinic needs; silently dropping
 * it makes "why did my client not get the reminder" unanswerable.
 */
export async function sendMessage(request: SendRequest): Promise<SendOutcome> {
  const context = getContext();
  const tx = getTx();
  const clinicId = context.clinicId!;

  const template = request.templateKey ? await loadTemplate(request.templateKey) : null;
  if (template?.whatsappTemplateName && getEnv().CONNECTOR_WHATSAPP === "live") await refreshTemplateApproval(template);
  const channel: SendableChannel = template
    ? (template.channel as SendableChannel)
    : request.adHoc!.channel;
  const classification: TemplateClassification = template
    ? template.classification
    : (request.adHoc!.classification ?? "operational");

  let destination = await resolveDestination(request.personId, channel);
  if (channel === "whatsapp" && request.conversationId) {
    const [lastInbound] = await tx.select({ recipient: messages.recipient }).from(messages).where(and(eq(messages.conversationId, request.conversationId), eq(messages.personId, request.personId), eq(messages.direction, "inbound"))).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
    destination = lastInbound?.recipient ?? destination;
  }

  // Every WhatsApp message, automated or not, belongs to the patient's inbox
  // thread — including ones that were blocked, so staff can see why.
  const conversationId =
    request.conversationId ??
    (channel === "whatsapp" ? await ensureConversation(request.personId, "whatsapp", request.leadId ?? null) : null);

  // --- The gate. Evaluated now, not when this was scheduled. ---------------
  const decision = await evaluateSend({
    clinicId,
    personId: request.personId,
    leadId: request.leadId ?? null,
    channel,
    classification,
    templateId: template?.id ?? null,
    whatsappTemplateName: template?.whatsappTemplateName ?? null,
    destination,
    idempotencyKey: request.idempotencyKey,
    ignoreQuietHours: request.ignoreQuietHours ?? false,
  });

  if (!decision.allowed) {
    // A duplicate key means an equivalent row already exists, so writing
    // another would violate the unique index we are relying on.
    if (decision.reason === "duplicate_idempotency_key") {
      logger.info(
        { correlationId: context.correlationId, reason: decision.reason },
        "Send skipped as duplicate",
      );
      const [existing] = await tx.select().from(messages).where(eq(messages.idempotencyKey, request.idempotencyKey));
      if (existing && ["sent", "delivered", "read"].includes(existing.state)) return { messageId: existing.id, state: "sent" };
      if (existing?.state === "failed") return { messageId: existing.id, state: "failed", detail: existing.failureDetail ?? "This attempt failed. Check delivery before composing a new message.", retryable: false };
      return { messageId: existing?.id ?? "", state: "suppressed", suppressionReason: decision.reason, detail: decision.detail };
    }

    const suppressed = await tx
      .insert(messages)
      .values({
        clinicId,
        personId: request.personId,
        leadId: request.leadId ?? null,
        channel,
        direction: "outbound",
        classification,
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        recipient: destination,
        state: "suppressed",
        suppressionReason: decision.reason,
        failureDetail: decision.detail,
        idempotencyKey: request.idempotencyKey,
        ruleId: request.ruleId ?? null,
        conversationId,
        triggeredByUserId: context.userId,
      })
      .returning({ id: messages.id });

    return {
      messageId: suppressed[0]!.id,
      state: "suppressed",
      suppressionReason: decision.reason,
      detail: decision.detail,
    };
  }

  // --- Render --------------------------------------------------------------
  const variables = {
    ...(await resolveVariables(request.personId, request.appointmentId ?? null)),
    // Every promotional email must carry a working opt-out, so the link is
    // generated here rather than left for a template author to remember.
    "link.unsubscribe": unsubscribeUrl({
      clinicId,
      personId: request.personId,
      channel,
    }),
    ...(request.variables ?? {}),
  };

  const bodySource = template?.body ?? request.adHoc!.body;
  const subjectSource = template?.subject ?? request.adHoc?.subject ?? null;

  const renderedBody = renderTemplate(bodySource, variables);
  const renderedSubject = subjectSource ? renderTemplate(subjectSource, variables) : null;

  if (renderedBody.missing.length > 0) {
    // Refuse rather than send a message with a visible gap in it (PRD MSG-02).
    const row = await tx
      .insert(messages)
      .values({
        clinicId,
        personId: request.personId,
        leadId: request.leadId ?? null,
        channel,
        direction: "outbound",
        classification,
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        recipient: destination,
        state: "failed",
        failureDetail: `Missing template variables: ${renderedBody.missing.join(", ")}`,
        idempotencyKey: request.idempotencyKey,
        ruleId: request.ruleId ?? null,
        conversationId,
        failedAt: new Date(),
      })
      .returning({ id: messages.id });
    return {
      messageId: row[0]!.id,
      state: "failed",
      detail: `Missing template variables: ${renderedBody.missing.join(", ")}`,
    };
  }

  // --- Record before sending ----------------------------------------------
  // The independent delivery receipt below survives this transaction rolling back.
  const inserted = await tx
    .insert(messages)
    .values({
      clinicId,
      personId: request.personId,
      leadId: request.leadId ?? null,
      channel,
      direction: "outbound",
      classification,
      templateId: template?.id ?? null,
      templateVersion: template?.version ?? null,
      recipient: destination,
      renderedSubject: renderedSubject?.text ?? null,
      renderedBody: renderedBody.text,
      state: "sending",
      attempts: 1,
      idempotencyKey: request.idempotencyKey,
      ruleId: request.ruleId ?? null,
      conversationId,
      triggeredByUserId: context.userId,
    })
    .returning({ id: messages.id });

  const messageId = inserted[0]!.id;
  const connectors = getConnectors();

  try {
    const clinicRow = (
      await tx
        .select({ name: clinics.name, sendingDomain: clinics.sendingDomain })
        .from(clinics)
        .limit(1)
    )[0];

    const result = await deliverOnce({ key: request.idempotencyKey, personId: request.personId, channel, payload: { destination, channel, classification, leadId: request.leadId ?? null, conversationId, templateId: template?.id ?? null, templateVersion: template?.version ?? null, ruleId: request.ruleId ?? null, triggeredByUserId: context.userId, body: renderedBody.text, subject: renderedSubject?.text, template: template?.whatsappTemplateName } }, async () =>
      channel === "email"
        ? await connectors.email.send({
            to: destination!,
            subject: renderedSubject?.text ?? "",
            text: renderedBody.text,
            fromAddress: `noreply@${clinicRow?.sendingDomain ?? "example-clinic.test"}`,
            fromName: clinicRow?.name ?? "Clinic",
            // Promotional mail carries List-Unsubscribe so mail apps show
            // their own one-click unsubscribe button.
            unsubscribeUrl: classification === "promotional" ? variables["link.unsubscribe"] ?? undefined : undefined,
            idempotencyKey: request.idempotencyKey,
          })
        : await (await whatsappConnector()).send(
            template?.whatsappTemplateName
              ? {
                  kind: "template",
                  toWaId: destination!,
                  templateName: template.whatsappTemplateName,
                  languageCode: template.whatsappLanguageCode ?? "en",
                  // Meta templates take positional parameters: the variables in the
                  // order the body uses them, not every variable we know.
                  variables: extractVariables(template.body).map((name) => (variables as Record<string, string | null>)[name] ?? ""),
                  idempotencyKey: request.idempotencyKey,
                }
              : {
                  kind: "text",
                  toWaId: destination!,
                  body: renderedBody.text,
                  idempotencyKey: request.idempotencyKey,
                },
          ));

    await tx
      .update(messages)
      .set({
        state: "sent",
        sentAt: result.acceptedAt,
        providerMessageId: result.providerMessageId,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, messageId));

    // A person sending a message is a response to the lead (D-73).
    await markFirstResponse(request.leadId ?? null, result.acceptedAt);

    if (conversationId) {
      await touchConversation(conversationId, { direction: "outbound", body: renderedBody.text, at: result.acceptedAt });
    }

    await addActivity({
      personId: request.personId,
      leadId: request.leadId ?? null,
      type: channel === "email" ? "email_sent" : "whatsapp_sent",
      summary: template ? `Sent "${template.name}"` : "Message sent",
      entityType: "message",
      entityId: messageId,
    });

    return { messageId, state: "sent" };
  } catch (error) {
    const connectorError = error instanceof ConnectorError ? error : null;
    const detail = connectorError?.message ?? "Provider rejected the message";

    await tx
      .update(messages)
      .set({
        state: "failed",
        failedAt: new Date(),
        // Provider detail only. Never the body.
        failureDetail: detail,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, messageId));

    // A hard bounce means this address must not be tried again.
    if (connectorError?.options.permanentSuppression && destination) {
      await tx
        .insert(suppressions)
        .values({
          clinicId,
          personId: request.personId,
          channel,
          destination,
          reason: "opted_out",
          detail: `Provider reported: ${detail}`,
        })
        .onConflictDoNothing({
          target: [suppressions.clinicId, suppressions.channel, suppressions.destination],
        });
    }

    logger.warn(
      { correlationId: context.correlationId, messageId, retryable: connectorError?.options.retryable },
      "Message send failed",
    );

    return { messageId, state: "failed", detail, retryable: connectorError?.options.retryable ?? false };
  }
}

async function loadTemplate(key: string) {
  const tx = getTx();
  const rows = await tx
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.key, key))
    .limit(1);
  const template = rows[0];
  if (!template) throw new Error(`No template with key "${key}" at this clinic`);
  return template;
}

/**
 * Values for the template variables.
 *
 * Deliberately narrow: person name, clinic details and appointment timing.
 * Nothing clinical, nothing from General Notes (PRD ID-08), and no service or
 * condition (PRD 8).
 */
export async function resolveVariables(
  personId: string,
  appointmentId: string | null,
): Promise<Record<string, string | null>> {
  const tx = getTx();

  const personRows = await tx
    .select({ firstName: people.firstName, displayName: people.displayName })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  const person = personRows[0];

  const clinicRows = await tx
    .select({
      name: clinics.name,
      postalAddress: clinics.postalAddress,
      timezone: clinics.timezone,
      supportEmail: clinics.supportEmail,
      phone: clinics.phone,
    })
    .from(clinics)
    .limit(1);
  const clinic = clinicRows[0];

  const variables: Record<string, string | null> = {
    "person.firstName": person?.firstName ?? person?.displayName?.split(" ")[0] ?? null,
    "person.fullName": person?.displayName ?? null,
    "clinic.name": clinic?.name ?? null,
    // The clinic's phone; before a phone is set, the contact email stands in.
    "clinic.phone": clinic?.phone ?? clinic?.supportEmail ?? null,
    "clinic.address": clinic?.postalAddress ?? null,
    "appointment.date": null,
    "appointment.time": null,
    "appointment.staffName": null,
    "link.unsubscribe": null,
    "link.reschedule": null,
  };

  if (appointmentId) {
    const rows = await tx
      .select({ startsAt: appointments.startsAt, staffName: users.fullName })
      .from(appointments)
      .innerJoin(users, eq(users.id, appointments.staffUserId))
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    const appointment = rows[0];
    if (appointment && clinic) {
      // Always shown in the clinic's timezone, never the server's.
      variables["appointment.date"] = new Intl.DateTimeFormat("en-US", {
        timeZone: clinic.timezone,
        dateStyle: "full",
      }).format(appointment.startsAt);
      variables["appointment.time"] = new Intl.DateTimeFormat("en-US", {
        timeZone: clinic.timezone,
        timeStyle: "short",
      }).format(appointment.startsAt);
      variables["appointment.staffName"] = appointment.staffName;
    }
  }

  return variables;
}

/** Record an opt-out. Blocks every future promotional send immediately. */
export async function recordOptOut(params: {
  personId: string;
  channel: SendableChannel;
  destination: string;
  detail?: string;
}): Promise<void> {
  const context = getContext();
  const tx = getTx();

  await tx
    .insert(suppressions)
    .values({
      clinicId: context.clinicId!,
      personId: params.personId,
      channel: params.channel,
      destination: params.destination,
      reason: "opted_out",
      detail: params.detail ?? "Unsubscribed",
    })
    .onConflictDoNothing({
      target: [suppressions.clinicId, suppressions.channel, suppressions.destination],
    });

  await recordAudit({
    action: "consent_changed",
    entityType: "person",
    entityId: params.personId,
    changeSummary: { optedOut: true, channel: params.channel },
  });
}
