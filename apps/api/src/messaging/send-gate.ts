import { and, desc, eq, gt, gte, isNull, or } from "drizzle-orm";
import {
  WHATSAPP_SERVICE_WINDOW_HOURS,
  type ConsentPurpose,
  type SendableChannel,
  type SuppressionReason,
  type TemplateClassification,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getEnv } from "@skincrm/config";
import { getTx } from "../context";

const {
  clinics,
  consentRecords,
  suppressions,
  messages,
  messageTemplates,
  leads,
  pipelineStages,
  people,
} = schema;

/**
 * The single place that decides whether a message may go out.
 *
 * PRD 4.4 / MSG-04..06 list the conditions; this implements all of them in one
 * function so no send path can accidentally skip one. It is called
 * **immediately before sending**, never at schedule time — a message queued
 * yesterday must be re-checked against consent, stage and template state as
 * they are now, because all three can change in between (PRD 7).
 *
 * Returning a reason rather than throwing is deliberate: a blocked message is
 * recorded in the delivery log with that reason, so "why did my client not get
 * the reminder" is always answerable (PRD MSG-07).
 */

export interface SendCandidate {
  clinicId: string;
  personId: string;
  leadId?: string | null;
  channel: SendableChannel;
  classification: TemplateClassification;
  templateId?: string | null;
  /** Resolved address or wa_id. */
  destination: string | null;
  idempotencyKey: string;
  /**
   * The Meta-approved template name, when this send uses one. A CRM template
   * row is not the same thing: a row with no provider template name is
   * free-form text and is bound by the service window.
   */
  whatsappTemplateName?: string | null;
  /** Skips quiet hours for genuinely time-critical operational messages. */
  ignoreQuietHours?: boolean;
  now?: Date;
}

export type SendDecision =
  | { allowed: true }
  | { allowed: false; reason: SuppressionReason; detail: string };

const block = (reason: SuppressionReason, detail: string): SendDecision => ({
  allowed: false,
  reason,
  detail,
});

/** Per-contact cap across all channels, to stop a misconfigured rule flooding. */
const FREQUENCY_CAP_PER_DAY = 5;

export async function evaluateSend(candidate: SendCandidate): Promise<SendDecision> {
  const tx = getTx();
  const env = getEnv();
  const now = candidate.now ?? new Date();

  // 1. The global kill switch. Checked first so nothing below can override it.
  if (!env.OUTBOUND_SENDING_ENABLED) {
    return block(
      "global_sending_disabled",
      "Outbound sending is switched off for this deployment (OUTBOUND_SENDING_ENABLED).",
    );
  }

  if (!candidate.destination || candidate.destination.trim() === "") {
    return block("missing_contact_detail", `No ${candidate.channel} address on this person.`);
  }

  // 2. Idempotency. The unique index is the real guard; this turns a would-be
  //    constraint violation into a recorded, explainable outcome.
  const existing = await tx
    .select({ id: messages.id, state: messages.state })
    .from(messages)
    .where(eq(messages.idempotencyKey, candidate.idempotencyKey))
    .limit(1);
  if (existing[0]) {
    return block(
      "duplicate_idempotency_key",
      `An equivalent message already exists (${existing[0].state}).`,
    );
  }

  // 3. Clinic-level approval for anything promotional (PRD 4.4, D-19).
  const clinicRows = await tx
    .select({
      promotionalSendingApproved: clinics.promotionalSendingApproved,
      quietHoursStart: clinics.quietHoursStart,
      quietHoursEnd: clinics.quietHoursEnd,
      timezone: clinics.timezone,
      postalAddress: clinics.postalAddress,
    })
    .from(clinics)
    .limit(1);
  const clinic = clinicRows[0];
  if (!clinic) return block("provider_paused", "Clinic settings could not be read.");

  if (candidate.classification === "promotional") {
    if (!clinic.promotionalSendingApproved) {
      return block(
        "no_consent",
        "The clinic has not approved promotional sending. Copy and legal basis need sign-off first.",
      );
    }
    if (candidate.channel === "email" && !clinic.postalAddress) {
      // CAN-SPAM requires a physical postal address on promotional email.
      return block(
        "template_not_approved",
        "Promotional email needs the clinic's postal address in settings.",
      );
    }
  }

  // 4. Hard suppression: a bounce, complaint or unsubscribe beats any consent.
  const suppressed = await tx
    .select({ reason: suppressions.reason, detail: suppressions.detail })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.channel, candidate.channel),
        eq(suppressions.destination, candidate.destination),
        or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, now))!,
      ),
    )
    .limit(1);
  if (suppressed[0]) {
    return block("opted_out", suppressed[0].detail ?? "This address is suppressed.");
  }

  // 5. Consent for this exact (channel, purpose).
  const consentDecision = await checkConsent(
    candidate.personId,
    candidate.channel,
    candidate.classification === "promotional" ? "promotional" : "operational",
  );
  if (consentDecision) return consentDecision;

  // 6. Lead state. A closed lead receives no further automated contact by
  //    default, and a converted or lost lead certainly should not be nurtured.
  if (candidate.leadId) {
    const leadRows = await tx
      .select({ isClosed: pipelineStages.isClosed, stageName: pipelineStages.name })
      .from(leads)
      .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
      .where(eq(leads.id, candidate.leadId))
      .limit(1);
    const lead = leadRows[0];
    if (lead?.isClosed && candidate.classification === "promotional") {
      return block("lead_closed", `The inquiry is closed (${lead.stageName}).`);
    }
  }

  // 7. Template must still be active and, for WhatsApp, still approved by Meta.
  if (candidate.templateId) {
    const templateRows = await tx
      .select({
        isActive: messageTemplates.isActive,
        archivedAt: messageTemplates.archivedAt,
        whatsappStatus: messageTemplates.whatsappStatus,
        name: messageTemplates.name,
      })
      .from(messageTemplates)
      .where(eq(messageTemplates.id, candidate.templateId))
      .limit(1);
    const template = templateRows[0];
    if (!template || !template.isActive || template.archivedAt) {
      return block("template_not_approved", "That template is no longer active.");
    }
    /**
     * Approval only applies to an actual Meta template. A CRM template row
     * with no provider template name is free-form copy, which Meta never
     * approves and which the service window governs instead.
     */
    if (candidate.channel === "whatsapp" && candidate.whatsappTemplateName) {
      if (template.whatsappStatus !== "approved") {
        // A paused or rejected template cannot be sent (PRD WA-06).
        return block(
          "template_not_approved",
          `WhatsApp template "${template.name}" is ${template.whatsappStatus ?? "unapproved"}, not approved.`,
        );
      }
    }
  }

  // 8. WhatsApp service window (PRD WA-06). Outside 24 hours from the
  //    customer's last inbound message, only an approved template may be sent.
  if (candidate.channel === "whatsapp") {
    const windowDecision = await checkWhatsAppWindow(candidate, now);
    if (windowDecision) return windowDecision;
  }

  // 9. Quiet hours, in the clinic's timezone.
  if (!candidate.ignoreQuietHours) {
    if (inQuietHours(now, clinic.timezone, clinic.quietHoursStart, clinic.quietHoursEnd)) {
      return block(
        "quiet_hours",
        `It is currently quiet hours (${clinic.quietHoursStart}–${clinic.quietHoursEnd} ${clinic.timezone}).`,
      );
    }
  }

  // 10. Per-contact frequency cap.
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recent = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.personId, candidate.personId),
        eq(messages.direction, "outbound"),
        gte(messages.createdAt, since),
        // Only messages that actually went out count against the cap.
        or(eq(messages.state, "sent"), eq(messages.state, "delivered"), eq(messages.state, "read"))!,
      ),
    );
  if (recent.length >= FREQUENCY_CAP_PER_DAY) {
    return block(
      "frequency_cap",
      `${recent.length} messages already sent to this person in the last 24 hours.`,
    );
  }

  return { allowed: true };
}

/**
 * Consent for a (channel, purpose), from the newest ledger row.
 *
 * Operational messages are allowed on `unknown` only because a clinic
 * confirming an appointment the client booked has a plain legitimate basis.
 * Promotional always requires an explicit `granted` (PRD MSG-04, BRD 7).
 */
async function checkConsent(
  personId: string,
  channel: SendableChannel,
  purpose: ConsentPurpose,
): Promise<SendDecision | null> {
  const tx = getTx();
  const rows = await tx
    .select({ status: consentRecords.status })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.personId, personId),
        eq(consentRecords.channel, channel),
        eq(consentRecords.purpose, purpose),
      ),
    )
    .orderBy(desc(consentRecords.occurredAt))
    .limit(1);

  const status = rows[0]?.status;

  if (status === "granted") return null;
  if (status === "withdrawn" || status === "denied") {
    return block("opted_out", `They have opted out of ${purpose} messages on ${channel}.`);
  }
  // No record at all, or explicitly unknown.
  if (purpose === "operational") return null;
  return block("no_consent", `No ${purpose} consent recorded for ${channel}.`);
}

/**
 * Meta permits a free-form reply only within 24 hours of the customer's last
 * inbound message. Outside it, an approved template is required (PRD WA-06).
 */
async function checkWhatsAppWindow(
  candidate: SendCandidate,
  now: Date,
): Promise<SendDecision | null> {
  // An approved Meta template may be sent at any time — step 7 checked that.
  // Free-form copy may not, whether or not it came from a CRM template row.
  if (candidate.whatsappTemplateName) return null;

  const tx = getTx();
  const inbound = await tx
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.personId, candidate.personId),
        eq(messages.channel, "whatsapp"),
        eq(messages.direction, "inbound"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const last = inbound[0]?.createdAt;
  const windowMs = WHATSAPP_SERVICE_WINDOW_HOURS * 60 * 60 * 1000;

  if (!last || now.getTime() - last.getTime() > windowMs) {
    return block(
      "outside_service_window",
      last
        ? `Their last message was more than ${WHATSAPP_SERVICE_WINDOW_HOURS} hours ago. Use an approved template.`
        : "They have never messaged this number. Use an approved template.",
    );
  }
  return null;
}

/**
 * Quiet hours in the clinic's timezone, handling a window that crosses
 * midnight — which the default 21:00–08:00 does.
 */
export function inQuietHours(
  now: Date,
  timeZone: string,
  start: string,
  end: string,
): boolean {
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);

  if (start === end) return false;
  if (start < end) {
    // A same-day window, e.g. 13:00–14:00.
    return localTime >= start && localTime < end;
  }
  // Crosses midnight, e.g. 21:00–08:00.
  return localTime >= start || localTime < end;
}

/** Where a message for this person on this channel should go. */
export async function resolveDestination(
  personId: string,
  channel: SendableChannel,
): Promise<string | null> {
  const tx = getTx();
  const rows = await tx
    .select({ email: people.emailNormalized, phone: people.phoneE164 })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  const person = rows[0];
  if (!person) return null;
  // WhatsApp addresses by wa_id, which is E.164 without the leading plus.
  return channel === "email" ? person.email : person.phone?.replace(/^\+/, "") ?? null;
}
