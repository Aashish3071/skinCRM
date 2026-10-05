import { createHash } from "node:crypto";
import { and, eq, isNull, isNotNull, lt } from "drizzle-orm";
import {
  schema,
  withTenant,
  getDeliveryDb,
  withoutTenantScope,
} from "@skincrm/db";
import { ConnectorError, type SendResult } from "@skincrm/connectors";
import { encryptForClinic, decryptForClinic } from "@skincrm/security";
import { runAsSystem } from "../automations/system-context";
import { getTx, getContext } from "../context";

const { deliveryAttempts } = schema;
const UNCERTAIN =
  "Delivery could not be confirmed. Automatic resend is blocked to prevent duplicates. Check the provider's delivery history before sending a new message.";

/** A write-ahead receipt survives rollback of the caller's CRM transaction.
 * A provider acknowledgement can be replayed without another network call.
 * Uncertain network/crash outcomes are never retried automatically. */
export async function deliverOnce(
  input: { key: string; personId: string; channel: string; payload: unknown },
  send: () => Promise<SendResult>,
): Promise<SendResult> {
  const clinicId = getContext().clinicId!;
  const content =
    input.payload && typeof input.payload === "object"
      ? Object.fromEntries(
          Object.entries(input.payload).filter(
            ([key]) => !["conversationId", "triggeredByUserId"].includes(key),
          ),
        )
      : input.payload;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        personId: input.personId,
        channel: input.channel,
        content,
      }),
    )
    .digest("hex");
  const claim = await withTenant(
    clinicId,
    async (tx) => {
      const inserted = await tx
        .insert(deliveryAttempts)
        .values({
          clinicId,
          idempotencyKey: input.key,
          fingerprint,
          personId: input.personId,
          channel: input.channel,
          payloadEncrypted: encryptForClinic(
            clinicId,
            JSON.stringify(input.payload),
          ),
        })
        .onConflictDoNothing()
        .returning();
      const row =
        inserted[0] ??
        (
          await tx
            .select()
            .from(deliveryAttempts)
            .where(eq(deliveryAttempts.idempotencyKey, input.key))
        )[0]!;
      return { row, fresh: inserted.length > 0 };
    },
    { db: getDeliveryDb().db },
  );
  if (claim.row.fingerprint !== fingerprint)
    throw new ConnectorError(
      "This send request was already used for different content. Refresh and compose a new message.",
      { retryable: false },
    );
  if (!claim.fresh) {
    if (
      claim.row.state === "accepted" &&
      claim.row.providerMessageId &&
      claim.row.acceptedAt
    )
      return {
        providerMessageId: claim.row.providerMessageId,
        acceptedAt: claim.row.acceptedAt,
      };
    if (claim.row.state === "rejected")
      throw new ConnectorError(
        claim.row.detail ?? "Provider rejected this message",
        {
          retryable: claim.row.retryable,
          permanentSuppression: claim.row.permanentSuppression,
        },
      );
    throw new ConnectorError(UNCERTAIN, {
      retryable: false,
      providerCode: "delivery_uncertain",
    });
  }
  let result: SendResult;
  try {
    result = await send();
  } catch (error) {
    // Only an explicit rejection proves that a retry cannot duplicate delivery.
    const known =
      error instanceof ConnectorError &&
      error.options.definitelyNotSent === true;
    if (known) {
      await withTenant(
        clinicId,
        (tx) =>
          tx
            .update(deliveryAttempts)
            .set({
              state: "rejected",
              detail: error.message.slice(0, 500),
              retryable: error.options.retryable,
              permanentSuppression: error.options.permanentSuppression ?? false,
              updatedAt: new Date(),
            })
            .where(eq(deliveryAttempts.id, claim.row.id)),
        { db: getDeliveryDb().db },
      );
      throw error;
    }
    throw new ConnectorError(UNCERTAIN, {
      retryable: false,
      providerCode: "delivery_uncertain",
    });
  }
  // If this commit fails, the durable uncertain claim still prevents a resend.
  await withTenant(
    clinicId,
    (tx) =>
      tx
        .update(deliveryAttempts)
        .set({
          state: "accepted",
          providerMessageId: result.providerMessageId,
          acceptedAt: result.acceptedAt,
          updatedAt: new Date(),
        })
        .where(eq(deliveryAttempts.id, claim.row.id)),
    { db: getDeliveryDb().db },
  );
  return result;
}

/** Restore the CRM history when the caller rolled back after a provider call.
 * Only committed receipts are considered and this function never sends. */
export async function reconcileDeliveryReceipts(): Promise<void> {
  const { messages, people } = schema;
  const candidates = await withoutTenantScope(
    "Find committed delivery receipts missing their CRM message",
    (db) =>
      db
        .select({ receipt: deliveryAttempts })
        .from(deliveryAttempts)
        .leftJoin(
          messages,
          and(
            eq(messages.clinicId, deliveryAttempts.clinicId),
            eq(messages.idempotencyKey, deliveryAttempts.idempotencyKey),
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.id, deliveryAttempts.personId),
            eq(people.clinicId, deliveryAttempts.clinicId),
          ),
        )
        .where(
          and(
            isNotNull(deliveryAttempts.payloadEncrypted),
            isNull(messages.id),
            lt(deliveryAttempts.createdAt, new Date(Date.now() - 120_000)),
          ),
        )
        .limit(100),
  );
  for (const { receipt } of candidates)
    await runAsSystem(receipt.clinicId, () => restoreReceipt(receipt));
}

export async function restoreReceipt(
  receipt: typeof deliveryAttempts.$inferSelect,
): Promise<void> {
  const { messages } = schema;
  if (!receipt.payloadEncrypted) return;
  if (
    !(
      await getTx()
        .select({ id: schema.people.id })
        .from(schema.people)
        .where(eq(schema.people.id, receipt.personId))
    )[0]
  )
    return;
  const p = JSON.parse(
    decryptForClinic(receipt.clinicId, receipt.payloadEncrypted),
  ) as {
    destination?: string;
    body?: string;
    subject?: string;
    classification?: "operational" | "promotional";
    leadId?: string;
    conversationId?: string;
    templateId?: string;
    templateVersion?: number;
    ruleId?: string;
    triggeredByUserId?: string;
  };
  if (receipt.channel !== "email" && receipt.channel !== "whatsapp") return;
  const tx = getTx();
  // References created in the rolled-back request may not exist.
  const leadId =
    p.leadId &&
    (
      await tx
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(eq(schema.leads.id, p.leadId))
    )[0]
      ? p.leadId
      : null;
  const conversationId =
    p.conversationId &&
    (
      await tx
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, p.conversationId))
    )[0]
      ? p.conversationId
      : null;
  await tx
    .insert(messages)
    .values({
      clinicId: receipt.clinicId,
      personId: receipt.personId,
      channel: receipt.channel,
      direction: "outbound",
      classification: p.classification ?? "operational",
      recipient: p.destination,
      renderedBody: p.body,
      renderedSubject: p.subject,
      leadId,
      conversationId,
      idempotencyKey: receipt.idempotencyKey,
      state: receipt.state === "accepted" ? "sent" : "failed",
      providerMessageId: receipt.providerMessageId,
      sentAt: receipt.acceptedAt,
      failureDetail: receipt.state === "uncertain" ? UNCERTAIN : receipt.detail,
      createdAt: receipt.createdAt,
      attempts: 1,
    })
    .onConflictDoNothing();
  if (conversationId) {
    await tx
      .update(schema.conversations)
      .set({
        lastMessageAt: receipt.acceptedAt ?? receipt.createdAt,
        lastPreview: p.body?.slice(0, 180),
        lastDirection: "outbound",
      })
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          lt(
            schema.conversations.lastMessageAt,
            receipt.acceptedAt ?? receipt.createdAt,
          ),
        ),
      );
  }
}
