import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { uuidSchema } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getTx } from "../context";
import { registerRoute } from "../route";
import { conflict, notFound } from "../errors";
import { recordAudit } from "../audit";
import { restoreReceipt } from "./delivery";
const { deliveryAttempts, messages, people } = schema;
export function registerDeliveryRecoveryRoutes(app: FastifyInstance) {
  registerRoute(app, {
    method: "GET",
    url: "/messages/delivery-review",
    auth: { capability: "templates:write" },
    handler: async () => ({
      items: await getTx()
        .select({
          id: deliveryAttempts.id,
          personId: deliveryAttempts.personId,
          personName: people.displayName,
          channel: deliveryAttempts.channel,
          state: deliveryAttempts.state,
          providerMessageId: deliveryAttempts.providerMessageId,
          createdAt: deliveryAttempts.createdAt,
        })
        .from(deliveryAttempts)
        .leftJoin(
          messages,
          and(
            eq(messages.clinicId, deliveryAttempts.clinicId),
            eq(messages.idempotencyKey, deliveryAttempts.idempotencyKey),
          ),
        )
        .leftJoin(people, eq(people.id, deliveryAttempts.personId))
        .where(
          and(
            lt(deliveryAttempts.createdAt, new Date(Date.now() - 120_000)),
            or(
              eq(deliveryAttempts.state, "uncertain"),
              and(eq(deliveryAttempts.state, "accepted"), isNull(messages.id)),
            ),
          ),
        )
        .orderBy(desc(deliveryAttempts.createdAt))
        .limit(100),
    }),
  });
  registerRoute(app, {
    method: "POST",
    url: "/messages/delivery-review/:id",
    auth: { capability: "templates:write" },
    params: z.object({ id: uuidSchema }),
    body: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("accepted"),
        providerMessageId: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(10).max(500),
      }),
      z.object({
        outcome: z.literal("not_sent"),
        reason: z.string().trim().min(10).max(500),
      }),
    ]),
    handler: async ({ params, body }) => {
      const tx = getTx();
      const [receipt] = await tx
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.id, params.id))
        .for("update");
      if (!receipt) throw notFound("No such delivery receipt.");
      if (receipt.state !== "uncertain")
        throw conflict(
          "This delivery already has a confirmed outcome. Refresh the page.",
        );
      if (receipt.createdAt.getTime() > Date.now() - 120_000)
        throw conflict(
          "This send may still be running. Wait two minutes before reviewing it.",
        );
      const [updated] = await tx
        .update(deliveryAttempts)
        .set({
          state: body.outcome === "accepted" ? "accepted" : "rejected",
          providerMessageId:
            body.outcome === "accepted" ? body.providerMessageId : null,
          acceptedAt: body.outcome === "accepted" ? receipt.createdAt : null,
          detail:
            body.outcome === "accepted"
              ? null
              : "An admin verified that this message was not sent. Compose a new message if needed.",
          retryable: false,
          updatedAt: new Date(),
        })
        .where(eq(deliveryAttempts.id, receipt.id))
        .returning();
      await restoreReceipt(updated!);
      await tx
        .update(messages)
        .set({
          state: body.outcome === "accepted" ? "sent" : "failed",
          providerMessageId: updated!.providerMessageId,
          sentAt: updated!.acceptedAt,
          failureDetail: updated!.detail,
          updatedAt: new Date(),
        })
        .where(eq(messages.idempotencyKey, receipt.idempotencyKey));
      await recordAudit({
        action: "record_updated",
        entityType: "delivery_receipt",
        entityId: receipt.id,
        changeSummary: {
          outcome: body.outcome,
          verificationReason: body.reason,
        },
      });
      return { ok: true };
    },
  });
}
