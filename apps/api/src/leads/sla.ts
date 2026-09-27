import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, withoutTenantScope } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { logger } from "../logger";
import { runAsSystem } from "../automations/system-context";
import { sendSystemEmail, webLink } from "../messaging/system-email";
import { addActivity } from "./service";
import { notifyUsers } from "../notifications/service";

const { leads, clinics, tasks, users, people } = schema;

/**
 * Response-time SLA (D-73): how long the team has to respond to a new lead.
 *
 * Due time is fixed when the lead is created. Anything a person does with the
 * lead — a logged call (answered or not), a message, moving it on from New —
 * counts as the first response. A lead nobody responds to in time is marked
 * breached once, and (if the clinic wants) escalated with a high-priority task
 * and an email to the owner and admins.
 */
export async function slaDueFor(createdAt: Date): Promise<Date | null> {
  const clinic = (await getTx().select({ minutes: clinics.firstResponseSlaMinutes }).from(clinics).limit(1))[0];
  if (!clinic || clinic.minutes <= 0) return null;
  return new Date(createdAt.getTime() + clinic.minutes * 60_000);
}

/** Stamp the first response, once. Only a person's action counts, never an automation's. */
export async function markFirstResponse(leadId: string | null | undefined, at = new Date()): Promise<void> {
  if (!leadId || !getContext().userId) return;
  await getTx()
    .update(leads)
    .set({ firstResponseAt: at })
    .where(and(eq(leads.id, leadId), isNull(leads.firstResponseAt)));
}

/** Worker job: find leads past their SLA, stamp and escalate each once. */
export async function processSlaBreaches(limit = 50, now = new Date()): Promise<number> {
  const due = await withoutTenantScope("worker: find leads past their response-time SLA", async (db) => {
    const rows = await db.execute<{ id: string; clinic_id: string }>(sql`
      update leads set sla_breached_at = ${now.toISOString()}::timestamptz
      where id in (
        select id from leads
        where sla_due_at <= ${now.toISOString()}::timestamptz and first_response_at is null
          and sla_breached_at is null and closed_at is null and archived_at is null and not is_test
        order by sla_due_at limit ${limit}
        for update skip locked
      )
      returning id, clinic_id
    `);
    return [...rows];
  });

  for (const row of due) {
    try {
      await runAsSystem(row.clinic_id, () => escalate(row.id), { correlationId: `sla-${row.id}` });
    } catch (error) {
      // The breach is already recorded; a failed escalation must not undo it.
      logger.warn({ leadId: row.id, err: error instanceof Error ? error.message : String(error) }, "SLA escalation failed");
    }
  }
  return due.length;
}

async function escalate(leadId: string): Promise<void> {
  const tx = getTx();
  const clinic = (await tx.select().from(clinics).limit(1))[0]!;
  const lead = (await tx.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  if (!lead) return;
  const person = (await tx.select({ name: people.displayName }).from(people).where(eq(people.id, lead.personId)).limit(1))[0];
  const name = person?.name ?? "A lead";

  await addActivity({
    personId: lead.personId,
    leadId: lead.id,
    type: "system",
    summary: `Response time missed — nobody responded within ${clinic.firstResponseSlaMinutes} minutes`,
  });
  const admins = (await tx.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.status, "active"), isNull(users.archivedAt))))
    .filter((u) => u.role === "admin").map((u) => u.id);
  await notifyUsers([lead.ownerUserId, ...admins], {
    type: "sla_missed",
    title: `No reply yet: ${name}`,
    body: `Came in ${clinic.firstResponseSlaMinutes} min ago`,
    link: `/leads/${lead.id}`,
    dedupeKey: `lead:${lead.id}:sla`,
  });
  if (!clinic.slaEscalationEnabled) return;

  await tx.insert(tasks).values({
    clinicId: clinic.id,
    leadId: lead.id,
    personId: lead.personId,
    title: `Reply to ${name} now — response time missed`,
    ownerUserId: lead.ownerUserId,
    dueAt: new Date(),
    priority: "urgent",
    createdByUserId: null,
  });

  const recipients = await tx
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.status, "active"), isNull(users.archivedAt)));
  const to = new Set(recipients.filter((u) => u.role === "admin" || u.id === lead.ownerUserId).map((u) => u.email));
  for (const address of to) {
    await sendSystemEmail({
      to: address,
      subject: `Missed response time: ${name}`,
      text: [
        `${name} came in ${clinic.firstResponseSlaMinutes} minutes ago and nobody has responded yet.`,
        "",
        lead.ownerUserId ? "An urgent task has been added for the lead's owner." : "Nobody owns this lead yet — please assign it.",
        "",
        `Open the lead: ${webLink(`/leads/${lead.id}`)}`,
      ].join("\n"),
    });
  }
}
