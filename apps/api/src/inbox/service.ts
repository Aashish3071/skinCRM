import { and, desc, eq, isNull } from "drizzle-orm";
import { normalizeWhatsAppId } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { ingestSubmission } from "../intake/pipeline";
import { addActivity } from "../leads/service";
import { ensureConversation, touchConversation } from "./store";
import { notifyUsers, usersWith } from "../notifications/service";

const { people, messages, leads, clinics } = schema;

export interface InboundWhatsApp {
  /** The sender's WhatsApp id: their number in international digits. */
  waId: string;
  /** The name on their WhatsApp profile, when the provider sends one. */
  profileName?: string | null;
  body: string;
  providerMessageId: string;
  receivedAt?: Date;
}

/**
 * Take in one WhatsApp message from a patient (PRD WA-01, WA-02).
 *
 * The same function will sit behind the real Cloud API webhook in phase 7; the
 * development "simulate" route calls it today. Idempotent on the provider's
 * message id, because webhooks are delivered at least once.
 *
 * An unknown number goes through the normal intake pipeline, so a first
 * message from a stranger becomes a person and a lead exactly like a web form.
 */
export async function receiveInboundWhatsApp(input: InboundWhatsApp): Promise<{ conversationId: string; duplicate: boolean }> {
  const context = getContext();
  const tx = getTx();
  const idempotencyKey = `wa-in:${input.providerMessageId}`;
  const at = input.receivedAt ?? new Date();

  const seen = await tx
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .limit(1);
  if (seen[0]?.conversationId) return { conversationId: seen[0].conversationId, duplicate: true };

  const clinic = (await tx.select({ country: clinics.country }).from(clinics).limit(1))[0];
  const phone = normalizeWhatsAppId(input.waId, clinic?.country ?? "US");
  if (!phone.e164) throw new Error("Inbound WhatsApp message has an unreadable sender id");

  let person = await findByPhone(phone.e164);
  let leadId: string | null = null;

  if (!person) {
    const [firstName, ...rest] = (input.profileName ?? "").trim().split(/\s+/);
    const outcome = await ingestSubmission({
      platform: "whatsapp",
      source: "whatsapp_organic",
      externalId: `wa:${phone.e164}`,
      submittedAt: at,
      firstName: firstName || null,
      lastName: rest.join(" ") || null,
      phone: phone.e164,
      inquiryNote: input.body.slice(0, 2_000),
      // Writing to the clinic is a clear basis for operational replies on
      // this channel; it is not consent to marketing.
      consent: [{ channel: "whatsapp", purpose: "operational", source: "whatsapp_inbound" }],
      clinicCountry: clinic?.country ?? "US",
    });
    if (outcome.status === "created") leadId = outcome.leadId;
    person = await findByPhone(phone.e164);
    if (!person) throw new Error("Could not match or create the sender");
  }

  if (!leadId) {
    const open = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.personId, person.id), isNull(leads.closedAt), isNull(leads.archivedAt)))
      .orderBy(desc(leads.createdAt))
      .limit(1);
    leadId = open[0]?.id ?? null;
  }

  // Every WhatsApp inquiry is a lead (D-70). A known patient writing in with
  // nothing open — a past client asking about a new treatment — gets a new
  // lead too, so the conversation never lives only in the inbox.
  if (!leadId) {
    const outcome = await ingestSubmission({
      platform: "whatsapp",
      source: "whatsapp_organic",
      externalId: `wa-msg:${input.providerMessageId}`,
      submittedAt: at,
      phone: phone.e164,
      inquiryNote: input.body.slice(0, 2_000),
      clinicCountry: clinic?.country ?? "US",
    });
    if (outcome.status === "created") leadId = outcome.leadId;
  }

  const conversationId = await ensureConversation(person.id, "whatsapp", leadId);

  await tx.insert(messages).values({
    clinicId: context.clinicId!,
    personId: person.id,
    leadId,
    channel: "whatsapp",
    direction: "inbound",
    classification: "operational",
    recipient: null,
    renderedBody: input.body,
    state: "delivered",
    providerMessageId: input.providerMessageId,
    idempotencyKey,
    conversationId,
    sentAt: at,
    deliveredAt: at,
  });

  await touchConversation(conversationId, { direction: "inbound", body: input.body, at });

  // One notification per chat, bumped on each new message (D-77).
  const convo = (await tx.select({ assignee: schema.conversations.assignedUserId }).from(schema.conversations).where(eq(schema.conversations.id, conversationId)).limit(1))[0];
  const who = (await tx.select({ name: people.displayName }).from(people).where(eq(people.id, person.id)).limit(1))[0];
  await notifyUsers(convo?.assignee ? [convo.assignee] : await usersWith("conversations:assign"), {
    type: "whatsapp_message",
    title: `WhatsApp from ${who?.name ?? "a patient"}`,
    body: input.body.split("\n")[0]!.slice(0, 80),
    link: `/inbox/${conversationId}`,
    dedupeKey: `wa:${conversationId}`,
  });

  await addActivity({
    personId: person.id,
    leadId,
    type: "whatsapp_received",
    summary: "WhatsApp message received",
    entityType: "conversation",
    entityId: conversationId,
  });

  return { conversationId, duplicate: false };
}

async function findByPhone(e164: string) {
  const rows = await getTx()
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.phoneE164, e164), isNull(people.archivedAt)))
    .limit(1);
  return rows[0] ?? null;
}
