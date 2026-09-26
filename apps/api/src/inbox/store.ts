import { and, eq, sql } from "drizzle-orm";
import type { ContactChannel } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";

const { conversations } = schema;

/**
 * Thread bookkeeping, kept free of messaging imports so the send service can
 * use it without an import cycle.
 */

/** The person's thread on this channel, created on first use. */
export async function ensureConversation(personId: string, channel: ContactChannel, leadId?: string | null): Promise<string> {
  const context = getContext();
  const tx = getTx();
  const inserted = await tx
    .insert(conversations)
    .values({ clinicId: context.clinicId!, personId, channel, leadId: leadId ?? null })
    .onConflictDoNothing({ target: [conversations.clinicId, conversations.personId, conversations.channel] })
    .returning({ id: conversations.id });
  if (inserted[0]) return inserted[0].id;

  const existing = await tx
    .select({ id: conversations.id, leadId: conversations.leadId })
    .from(conversations)
    .where(and(eq(conversations.personId, personId), eq(conversations.channel, channel)))
    .limit(1);
  if (leadId && existing[0] && !existing[0].leadId) {
    await tx.update(conversations).set({ leadId }).where(eq(conversations.id, existing[0].id));
  }
  return existing[0]!.id;
}

/** Record that a message went into the thread. First line only is kept as the preview. */
export async function touchConversation(
  id: string,
  message: { direction: "inbound" | "outbound"; body: string | null; at: Date },
): Promise<void> {
  const preview = (message.body ?? "").split("\n").find((l) => l.trim())?.slice(0, 140) ?? null;
  await getTx()
    .update(conversations)
    .set({
      lastMessageAt: message.at,
      lastPreview: preview,
      lastDirection: message.direction,
      updatedAt: new Date(),
      ...(message.direction === "inbound"
        ? {
            lastInboundAt: message.at,
            unreadCount: sql`${conversations.unreadCount} + 1`,
            // A new message reopens a thread that was marked done.
            status: "open" as const,
          }
        : {}),
    })
    .where(eq(conversations.id, id));
}
