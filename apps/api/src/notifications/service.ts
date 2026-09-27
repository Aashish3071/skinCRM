import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { roleHasCapability, type Capability, type NotificationType } from "@skincrm/contracts";
import { schema, withoutTenantScope } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { logger } from "../logger";
import { runAsSystem } from "../automations/system-context";

const { notifications, users } = schema;

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Unique per person: a repeat bumps the existing notification instead of adding one. */
  dedupeKey: string;
}

/**
 * Send an in-app notification to people, skipping anyone who switched that
 * type off and — for things a person did themselves — the person who did it.
 * Never throws: a failed notification must not undo the work that caused it.
 */
export async function notifyUsers(userIds: (string | null | undefined)[], input: NotifyInput): Promise<void> {
  try {
    const context = getContext();
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id) && id !== context.userId))];
    if (ids.length === 0) return;
    const tx = getTx();
    const people = await tx
      .select({ id: users.id, muted: users.mutedNotifications })
      .from(users)
      .where(and(eq(users.status, "active"), isNull(users.archivedAt), inArray(users.id, ids)));
    const targets = people.filter((p) => !(p.muted ?? []).includes(input.type));
    for (const p of targets) {
      await tx
        .insert(notifications)
        .values({
          clinicId: context.clinicId!,
          userId: p.id,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          link: input.link ?? null,
          dedupeKey: input.dedupeKey,
        })
        .onConflictDoUpdate({
          target: [notifications.userId, notifications.dedupeKey],
          set: { title: input.title, body: input.body ?? null, link: input.link ?? null, readAt: null, createdAt: new Date() },
        });
    }
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error), type: input.type }, "Notification failed");
  }
}

/** Everyone active whose role has a capability (e.g. who can pick up unassigned leads). */
export async function usersWith(capability: Capability): Promise<string[]> {
  const rows = await getTx()
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.status, "active"), isNull(users.archivedAt)));
  return rows.filter((u) => roleHasCapability(u.role, capability)).map((u) => u.id);
}

/** A new lead: tell its owner, or everyone who can pick it up if nobody owns it. */
export async function notifyNewLead(lead: { id: string; ownerUserId: string | null }, personName: string, sourceLabel: string): Promise<void> {
  if (lead.ownerUserId) {
    await notifyUsers([lead.ownerUserId], {
      type: "lead_assigned",
      title: `New lead for you: ${personName}`,
      body: `From ${sourceLabel}`,
      link: `/leads/${lead.id}`,
      dedupeKey: `lead:${lead.id}:assigned:${lead.ownerUserId}`,
    });
  } else {
    await notifyUsers(await usersWith("leads:assign"), {
      type: "lead_new",
      title: `New lead: ${personName}`,
      body: `From ${sourceLabel} · nobody owns it yet`,
      link: `/leads/${lead.id}`,
      dedupeKey: `lead:${lead.id}:new`,
    });
  }
}

/**
 * Worker job: appointments starting within the hour and tasks now due. Runs
 * per clinic; the dedupe key makes each fire once however often it runs.
 */
export async function processTimedNotifications(now = new Date()): Promise<void> {
  const clinics = await withoutTenantScope("worker: list clinics for timed notifications", (db) =>
    db.execute<{ id: string }>(sql`
      select distinct clinic_id as id from appointments
        where starts_at between ${now.toISOString()}::timestamptz and ${now.toISOString()}::timestamptz + interval '60 minutes'
          and status in ('scheduled', 'confirmed')
      union
      select distinct clinic_id from tasks
        where status = 'open' and due_at between ${now.toISOString()}::timestamptz - interval '1 day' and ${now.toISOString()}::timestamptz + interval '5 minutes'
    `),
  );
  for (const { id } of clinics) {
    await runAsSystem(id, async () => {
      const tx = getTx();
      const soon = await tx.execute<{ id: string; staff_user_id: string; name: string; starts_at: Date; lead_id: string | null; person_id: string }>(sql`
        select a.id, a.staff_user_id, p.display_name as name, a.starts_at, a.lead_id, a.person_id
        from appointments a join people p on p.id = a.person_id
        where a.starts_at between ${now.toISOString()}::timestamptz and ${now.toISOString()}::timestamptz + interval '60 minutes'
          and a.status in ('scheduled', 'confirmed')
      `);
      for (const a of soon) {
        const mins = Math.max(1, Math.round((new Date(a.starts_at).getTime() - now.getTime()) / 60_000));
        await notifyUsers([a.staff_user_id], {
          type: "appointment_soon",
          title: `${a.name} in ${mins} min`,
          body: "Upcoming appointment",
          link: a.lead_id ? `/leads/${a.lead_id}` : `/people/${a.person_id}`,
          dedupeKey: `appt:${a.id}:soon`,
        });
      }
      const due = await tx.execute<{ id: string; owner_user_id: string | null; title: string; lead_id: string | null }>(sql`
        select id, owner_user_id, title, lead_id from tasks
        where status = 'open' and owner_user_id is not null
          and due_at between ${now.toISOString()}::timestamptz - interval '1 day' and ${now.toISOString()}::timestamptz + interval '5 minutes'
      `);
      for (const t of due) {
        await notifyUsers([t.owner_user_id], {
          type: "task_due",
          title: `Task due: ${t.title}`,
          link: t.lead_id ? `/leads/${t.lead_id}` : "/home",
          dedupeKey: `task:${t.id}:due`,
        });
      }
    });
  }
}
