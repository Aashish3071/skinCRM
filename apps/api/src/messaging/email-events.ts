import { and, eq } from "drizzle-orm";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { addActivity } from "../leads/service";

const { messages, suppressions, consentRecords, people } = schema;

/**
 * What Postmark tells us after an email left (D-96):
 *  - Delivery: the receiving server accepted it.
 *  - Bounce: a hard bounce (Postmark marks the address inactive) suppresses the
 *    address for good; a soft bounce is recorded but not suppressed.
 *  - SpamComplaint: suppress, and withdraw marketing email consent.
 *  - SubscriptionChange: an unsubscribe through Postmark's own link.
 * Never moves a message backwards (a late Delivery can't undo a bounce).
 */
export async function applyEmailEvent(e: {
  RecordType: string;
  MessageID: string;
  Email?: string;
  Recipient?: string;
  Type?: string;
  Description?: string;
  Details?: string;
  Inactive?: boolean;
  SuppressSending?: boolean;
  DeliveredAt?: string;
  BouncedAt?: string;
  ReceivedAt?: string;
}): Promise<string> {
  const tx = getTx();
  const clinicId = getContext().clinicId!;
  const [message] = await tx.select().from(messages).where(and(eq(messages.providerMessageId, e.MessageID), eq(messages.channel, "email"))).limit(1);
  const address = (e.Email ?? e.Recipient ?? message?.recipient ?? "").trim().toLowerCase();
  const personId = message?.personId
    ?? (address ? (await tx.select({ id: people.id }).from(people).where(eq(people.emailNormalized, address)).limit(1))[0]?.id : undefined)
    ?? null;
  const when = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : new Date());

  const suppress = async (reason: "hard_bounce" | "spam_complaint" | "opted_out", detail: string) => {
    if (!address) return;
    await tx.insert(suppressions).values({ clinicId, personId, channel: "email", destination: address, reason, detail })
      .onConflictDoNothing({ target: [suppressions.clinicId, suppressions.channel, suppressions.destination] });
  };
  const withdrawMarketing = async (evidence: string) => {
    if (!personId) return;
    await tx.insert(consentRecords).values({ clinicId, personId, channel: "email", purpose: "promotional", status: "withdrawn", source: "unsubscribe_link", evidenceReference: evidence });
  };

  switch (e.RecordType) {
    case "Delivery":
      if (message?.state === "sent") {
        await tx.update(messages).set({ state: "delivered", deliveredAt: when(e.DeliveredAt), updatedAt: new Date() }).where(eq(messages.id, message.id));
      }
      return "delivered";
    case "Bounce": {
      const hard = e.Inactive === true || e.Type === "HardBounce" || e.Type === "BadEmailAddress";
      const detail = `${e.Description ?? e.Type ?? "Bounced"}${e.Details ? ` — ${e.Details.slice(0, 200)}` : ""}`;
      if (message && message.state !== "bounced") {
        await tx.update(messages).set(hard ? { state: "bounced", failedAt: when(e.BouncedAt), failureDetail: detail, updatedAt: new Date() } : { failureDetail: `Temporary: ${detail}`, updatedAt: new Date() }).where(eq(messages.id, message.id));
      }
      if (hard) {
        await suppress("hard_bounce", detail);
        if (personId) await addActivity({ personId, leadId: message?.leadId ?? null, type: "note", summary: "Email address bounced — emails to it are stopped. Ask for a new address." });
      }
      return hard ? "hard_bounce" : "soft_bounce";
    }
    case "SpamComplaint":
      await suppress("spam_complaint", "Marked an email as spam");
      await withdrawMarketing(`postmark:${e.MessageID}`);
      return "complaint";
    case "SubscriptionChange":
      if (e.SuppressSending) {
        await suppress("opted_out", "Unsubscribed through the email's unsubscribe link");
        await withdrawMarketing(`postmark:${e.MessageID}`);
        return "unsubscribed";
      }
      return "resubscribed_ignored";
    default:
      return `ignored:${e.RecordType}`;
  }
}
