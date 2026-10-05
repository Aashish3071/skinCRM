import type { FastifyInstance } from "fastify";
import { and, eq, gt, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getEnv } from "@skincrm/config";
import { ConnectorError, getCalendarClient, type CalendarProvider } from "@skincrm/connectors";
import { schema, withoutTenantScope } from "@skincrm/db";
import { decryptForClinic, encryptForClinic, generateToken, hashToken } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { logger } from "../logger";
import { runAsSystem } from "../automations/system-context";

/**
 * Two-way staff calendar sync (PRD CAL-07, D-94).
 *
 * Reconciliation, not a stream of one-off messages: each run compares the
 * person's SkinCRM appointments with what we put in their calendar and fixes
 * the difference (create / update / delete), then refreshes their busy times.
 * A missed run or a provider outage just means the next run catches up.
 *
 *  Out: active appointments from yesterday to 90 days ahead become events —
 *       "{type} — {first name} {last initial}." and a link back. No notes,
 *       phone numbers or services beyond the appointment type.
 *  In:  other events in that window, as start/end times only, stored in
 *       `external_busy` and treated as booked by staff booking and the online
 *       booking page. Events we created are skipped.
 */
const { calendarConnections, calendarEventLinks, externalBusy, appointments, people, consultationTypes, authTokens } = schema;
const PROVIDERS = ["google", "microsoft"] as const;
const WINDOW_BACK_MS = 86_400_000;
const WINDOW_AHEAD_MS = 90 * 86_400_000;
const SYNC_EVERY_MS = 5 * 60_000;

export function calendarRedirectUri(provider: CalendarProvider): string {
  return new URL(`/settings/profile/calendar/${provider}/callback`, getEnv().PUBLIC_WEB_URL).toString();
}

function eventFor(row: { appointment: typeof appointments.$inferSelect; firstName: string | null; lastName: string | null; displayName: string; typeName: string | null }) {
  const first = row.firstName ?? row.displayName.split(" ")[0] ?? "Patient";
  const initial = row.lastName ? ` ${row.lastName.trim()[0]?.toUpperCase()}.` : "";
  const day = row.appointment.startsAt.toISOString().slice(0, 10);
  return {
    appointmentId: row.appointment.id,
    title: `${row.typeName ?? "Appointment"} — ${first}${initial}`,
    description: `Booked in SkinCRM. Open the calendar: ${new URL(`/calendar?date=${day}&view=day`, getEnv().PUBLIC_WEB_URL)}`,
    startsAt: row.appointment.startsAt,
    endsAt: row.appointment.clientVisibleEndsAt ?? row.appointment.endsAt,
  };
}

/** Reconcile one connection. Runs inside the clinic's tenant transaction. */
export async function syncCalendarConnection(connectionId: string): Promise<{ created: number; updated: number; deleted: number; busy: number }> {
  const tx = getTx();
  const [connection] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId)).limit(1);
  if (!connection) return { created: 0, updated: 0, deleted: 0, busy: 0 };
  const client = getCalendarClient(connection.provider);
  const counts = { created: 0, updated: 0, deleted: 0, busy: 0 };

  try {
    const token = await client.accessToken(decryptForClinic(connection.clinicId, connection.encryptedSecret));
    if (token.refreshToken) {
      // Microsoft rotates refresh tokens: keep the newest or the next run fails.
      await tx.update(calendarConnections).set({ encryptedSecret: encryptForClinic(connection.clinicId, token.refreshToken) }).where(eq(calendarConnections.id, connection.id));
    }
    const from = new Date(Date.now() - WINDOW_BACK_MS);
    const to = new Date(Date.now() + WINDOW_AHEAD_MS);

    // --- Out: appointments → events ------------------------------------------
    const wanted = await tx
      .select({ appointment: appointments, firstName: people.firstName, lastName: people.lastName, displayName: people.displayName, typeName: consultationTypes.name })
      .from(appointments)
      .innerJoin(people, eq(people.id, appointments.personId))
      .leftJoin(consultationTypes, eq(consultationTypes.id, appointments.consultationTypeId))
      .where(and(
        eq(appointments.staffUserId, connection.userId),
        gte(appointments.startsAt, from), lt(appointments.startsAt, to),
        notInArray(appointments.status, ["canceled", "rescheduled"]),
      ));
    const links = await tx.select().from(calendarEventLinks).where(eq(calendarEventLinks.connectionId, connection.id));
    const linkByAppointment = new Map(links.map((l) => [l.appointmentId, l]));

    for (const row of wanted) {
      const link = linkByAppointment.get(row.appointment.id);
      if (!link) {
        const eventId = await client.createEvent(token.accessToken, connection.calendarId, eventFor(row));
        await tx.insert(calendarEventLinks).values({ clinicId: connection.clinicId, connectionId: connection.id, appointmentId: row.appointment.id, externalEventId: eventId, syncedVersion: row.appointment.updatedAt });
        counts.created += 1;
      } else if (row.appointment.updatedAt.getTime() > link.syncedVersion.getTime()) {
        await client.updateEvent(token.accessToken, connection.calendarId, link.externalEventId, eventFor(row));
        await tx.update(calendarEventLinks).set({ syncedVersion: row.appointment.updatedAt }).where(eq(calendarEventLinks.id, link.id));
        counts.updated += 1;
      }
    }

    // Cancelled, moved (the replacement gets its own event) or reassigned away.
    const wantedIds = new Set(wanted.map((w) => w.appointment.id));
    const stale = links.length
      ? await tx.select({ link: calendarEventLinks, status: appointments.status, staffUserId: appointments.staffUserId, startsAt: appointments.startsAt })
          .from(calendarEventLinks)
          .innerJoin(appointments, eq(appointments.id, calendarEventLinks.appointmentId))
          .where(eq(calendarEventLinks.connectionId, connection.id))
      : [];
    for (const s of stale) {
      if (wantedIds.has(s.link.appointmentId)) continue;
      const gone = s.status === "canceled" || s.status === "rescheduled" || s.staffUserId !== connection.userId;
      if (!gone) continue; // Simply outside the window now: leave the past event alone.
      await client.deleteEvent(token.accessToken, connection.calendarId, s.link.externalEventId);
      await tx.delete(calendarEventLinks).where(eq(calendarEventLinks.id, s.link.id));
      counts.deleted += 1;
    }

    // --- In: their other events → busy times ---------------------------------
    const ours = new Set((await tx.select({ id: calendarEventLinks.externalEventId }).from(calendarEventLinks).where(eq(calendarEventLinks.connectionId, connection.id))).map((r) => r.id));
    const busy = (await client.listBusy(token.accessToken, connection.calendarId, new Date(), to)).filter((b) => !ours.has(b.externalId) && b.endsAt > b.startsAt);
    await tx.delete(externalBusy).where(eq(externalBusy.connectionId, connection.id));
    if (busy.length) {
      await tx.insert(externalBusy).values(busy.slice(0, 5000).map((b) => ({ clinicId: connection.clinicId, connectionId: connection.id, userId: connection.userId, startsAt: b.startsAt, endsAt: b.endsAt })));
    }
    counts.busy = busy.length;

    await tx.update(calendarConnections).set({ status: "healthy", lastError: null, lastSyncedAt: new Date() }).where(eq(calendarConnections.id, connection.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    logger.warn({ connectionId, err: message }, "Calendar sync failed");
    await tx.update(calendarConnections).set({ status: "error", lastError: message.slice(0, 500) }).where(eq(calendarConnections.id, connection.id));
    if (!(error instanceof ConnectorError)) throw error;
  }
  return counts;
}

/** Worker: every connection not synced in the last few minutes. */
export async function syncDueCalendars(): Promise<number> {
  const cutoff = new Date(Date.now() - SYNC_EVERY_MS);
  const due = await withoutTenantScope("calendar sync: find due connections", (db) =>
    db.select({ id: calendarConnections.id, clinicId: calendarConnections.clinicId }).from(calendarConnections)
      .where(or(isNull(calendarConnections.lastSyncedAt), lt(calendarConnections.lastSyncedAt, cutoff))).limit(50),
  );
  for (const c of due) {
    try {
      await runAsSystem(c.clinicId, () => syncCalendarConnection(c.id));
    } catch (error) {
      logger.error({ connectionId: c.id, err: error instanceof Error ? error.message : String(error) }, "Calendar sync crashed");
    }
  }
  return due.length;
}

/** Busy times from staff calendars overlapping a range (used by availability). */
export async function externalBusyFor(userId: string, from: Date, to: Date) {
  return getTx().select({ startsAt: externalBusy.startsAt, endsAt: externalBusy.endsAt }).from(externalBusy)
    .where(and(eq(externalBusy.userId, userId), lt(externalBusy.startsAt, to), gt(externalBusy.endsAt, from)));
}

async function removeConnection(connection: typeof calendarConnections.$inferSelect): Promise<void> {
  const tx = getTx();
  // Best effort: take our events out of their calendar before forgetting the link.
  try {
    const client = getCalendarClient(connection.provider);
    const token = await client.accessToken(decryptForClinic(connection.clinicId, connection.encryptedSecret));
    const links = await tx.select().from(calendarEventLinks).where(eq(calendarEventLinks.connectionId, connection.id));
    for (const l of links) await client.deleteEvent(token.accessToken, connection.calendarId, l.externalEventId).catch(() => {});
  } catch (error) {
    logger.warn({ connectionId: connection.id, err: error instanceof Error ? error.message : String(error) }, "Could not remove calendar events on disconnect");
  }
  await tx.delete(calendarConnections).where(eq(calendarConnections.id, connection.id));
}

function serialize(c: typeof calendarConnections.$inferSelect | undefined) {
  if (!c) return null;
  return { provider: c.provider, accountEmail: c.accountEmail, status: c.status, lastError: c.lastError, lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null };
}

const providerParam = z.object({ provider: z.enum(PROVIDERS) });

export function registerCalendarSyncRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "GET",
    url: "/me/calendar-sync",
    auth: { capability: "appointments:read" },
    handler: async () => {
      const [row] = await getTx().select().from(calendarConnections).where(eq(calendarConnections.userId, getContext().userId!)).limit(1);
      return { connection: serialize(row), demo: getEnv().CONNECTOR_CALENDAR !== "live" };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/me/calendar-sync/:provider/start",
    auth: { capability: "appointments:read" },
    params: providerParam,
    handler: async ({ params }) => {
      const context = getContext();
      let client;
      try {
        client = getCalendarClient(params.provider);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Calendar sync isn't configured.");
      }
      const { token, tokenHash } = generateToken(32);
      await getTx().insert(authTokens).values({
        clinicId: context.clinicId!, userId: context.userId, purpose: "oauth_state", tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60_000), metadata: { provider: `calendar:${params.provider}` },
      });
      return { url: client.authorizeUrl({ state: token, redirectUri: calendarRedirectUri(params.provider) }) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/me/calendar-sync/:provider/callback",
    auth: { capability: "appointments:read" },
    params: providerParam,
    body: z.object({ code: z.string().min(1).max(2000), state: z.string().min(20).max(200) }),
    handler: async ({ params, body }) => {
      const context = getContext();
      const tx = getTx();
      const [state] = await tx.update(authTokens).set({ consumedAt: new Date() })
        .where(and(eq(authTokens.tokenHash, hashToken(body.state)), eq(authTokens.purpose, "oauth_state"), eq(authTokens.userId, context.userId!),
          sql`${authTokens.consumedAt} is null`, sql`${authTokens.expiresAt} > now()`))
        .returning();
      if (!state || state.metadata.provider !== `calendar:${params.provider}`) throw badRequest("This sign-in link has expired or was already used. Try again from My profile.");

      const client = getCalendarClient(params.provider);
      let granted;
      try {
        granted = await client.exchangeCode({ code: body.code, redirectUri: calendarRedirectUri(params.provider) });
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "The calendar sign-in failed.");
      }
      // One calendar per person: switching takes our events out of the old one.
      const [old] = await tx.select().from(calendarConnections).where(eq(calendarConnections.userId, context.userId!)).limit(1);
      if (old) await removeConnection(old);
      const [created] = await tx.insert(calendarConnections).values({
        clinicId: context.clinicId!, userId: context.userId!, provider: params.provider, accountEmail: granted.accountEmail,
        encryptedSecret: encryptForClinic(context.clinicId!, granted.refreshToken),
      }).returning();
      await recordAudit({ action: "integration_connected", entityType: "calendar_connection", entityId: created!.id, changeSummary: { provider: params.provider } });
      const counts = await syncCalendarConnection(created!.id);
      const [fresh] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, created!.id));
      return { connection: serialize(fresh), counts };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/me/calendar-sync/sync",
    auth: { capability: "appointments:read" },
    handler: async () => {
      const [row] = await getTx().select().from(calendarConnections).where(eq(calendarConnections.userId, getContext().userId!)).limit(1);
      if (!row) throw badRequest("Connect a calendar first.");
      const counts = await syncCalendarConnection(row.id);
      const [fresh] = await getTx().select().from(calendarConnections).where(eq(calendarConnections.id, row.id));
      return { connection: serialize(fresh), counts };
    },
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/me/calendar-sync",
    auth: { capability: "appointments:read" },
    status: 204,
    handler: async () => {
      const [row] = await getTx().select().from(calendarConnections).where(eq(calendarConnections.userId, getContext().userId!)).limit(1);
      if (row) {
        await removeConnection(row);
        await recordAudit({ action: "integration_disconnected", entityType: "calendar_connection", entityId: row.id, changeSummary: { provider: row.provider } });
      }
      return null;
    },
  });
}

/** For admins: who has a calendar connected and whether it's healthy. */
export async function calendarConnectionsByUser(userIds: string[]) {
  if (!userIds.length) return [];
  return getTx().select({ userId: calendarConnections.userId, provider: calendarConnections.provider, status: calendarConnections.status })
    .from(calendarConnections).where(inArray(calendarConnections.userId, userIds));
}
