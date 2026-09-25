import { and, eq, isNull, lt, or } from "drizzle-orm";
import {
  GRANTABLE_CAPABILITIES,
  capabilitiesForRole,
  type Capability,
  type SessionUser,
} from "@skincrm/contracts";
import { getOwnerDb, schema, sql, withoutTenantScope, withTenant } from "@skincrm/db";
import { generateToken, hashToken } from "@skincrm/security";
import { getEnv } from "@skincrm/config";

const { sessions, users, clinics, userBranches } = schema;

export const SESSION_COOKIE = "skincrm_session";

/** Absolute lifetime. A session cannot outlive this even with continuous use. */
const SESSION_ABSOLUTE_DAYS = 30;
/** Idle timeout. An unused session dies sooner than its absolute expiry. */
const SESSION_IDLE_HOURS = 12;

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
}

export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Browsers reject Secure cookies over plain http, which localhost uses.
    secure: getEnv().NODE_ENV !== "development",
    path: "/",
    maxAge: SESSION_ABSOLUTE_DAYS * 24 * 60 * 60,
  };
}

/**
 * Issue a session. Returns the plaintext token for the cookie; only its hash is
 * stored, so a database read cannot be replayed as a login.
 */
export async function createSession(params: {
  clinicId: string;
  userId: string;
  sessionEpoch: number;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash } = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000);

  await withTenant(params.clinicId, async (tx) => {
    await tx.insert(sessions).values({
      clinicId: params.clinicId,
      userId: params.userId,
      tokenHash,
      sessionEpoch: params.sessionEpoch,
      expiresAt,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  });

  return { token, expiresAt };
}

/**
 * Resolve a cookie value to a signed-in user, or null.
 *
 * Runs unscoped because the clinic is unknown until the session row is read —
 * that is the whole point of the lookup. Everything after this point is
 * tenant-scoped using the clinic id found here.
 */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const rows = await withoutTenantScope("resolve session cookie before the clinic is known", async (db) =>
    db
      .select({
        sessionId: sessions.id,
        sessionEpoch: sessions.sessionEpoch,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        revokedAt: sessions.revokedAt,
        userId: users.id,
        clinicId: users.clinicId,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        status: users.status,
        grantedCapabilities: users.grantedCapabilities,
        mfaEnabledAt: users.mfaEnabledAt,
        userSessionEpoch: users.sessionEpoch,
        userArchivedAt: users.archivedAt,
        clinicName: clinics.name,
        clinicTimezone: clinics.timezone,
        clinicCountry: clinics.country,
        clinicArchivedAt: clinics.archivedAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(clinics, eq(clinics.id, users.clinicId))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= now) return null;
  // Idle timeout: a session unused for longer than the window is dead even
  // though its absolute expiry has not passed.
  if (now - row.lastSeenAt.getTime() > SESSION_IDLE_HOURS * 60 * 60 * 1000) return null;
  // Mass revocation: one bump of users.session_epoch invalidates every session.
  if (row.sessionEpoch !== row.userSessionEpoch) return null;
  if (row.status !== "active") return null;
  if (row.userArchivedAt || row.clinicArchivedAt) return null;

  // Slide the idle window. Throttled to once a minute so a busy tab does not
  // write on every request.
  if (now - row.lastSeenAt.getTime() > 60_000) {
    await withTenant(row.clinicId, async (tx) => {
      await tx.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
    });
  }

  const branchRows = await withTenant(row.clinicId, async (tx) =>
    tx.select({ branchId: userBranches.branchId }).from(userBranches).where(eq(userBranches.userId, row.userId)),
  );

  const capabilities = mergeCapabilities(row.role, row.grantedCapabilities);

  return {
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      clinicId: row.clinicId,
      email: row.email,
      fullName: row.fullName,
      role: row.role,
      status: row.status,
      capabilities,
      mfaEnabled: row.mfaEnabledAt !== null,
      branchIds: branchRows.map((b) => b.branchId),
      clinic: {
        id: row.clinicId,
        name: row.clinicName,
        timezone: row.clinicTimezone,
        country: row.clinicCountry,
      },
    },
  };
}

/**
 * Role capabilities plus any per-user grants. Only capabilities a clinic may
 * actually delegate are honoured, so a stale or tampered row cannot widen a
 * role beyond what the product allows.
 */
export function mergeCapabilities(
  role: SessionUser["role"],
  granted: readonly Capability[] | null,
): Capability[] {
  const base = new Set<Capability>(capabilitiesForRole(role));
  for (const capability of granted ?? []) {
    if (GRANTABLE.has(capability)) base.add(capability);
  }
  return [...base];
}

const GRANTABLE: ReadonlySet<Capability> = new Set(GRANTABLE_CAPABILITIES);

export async function revokeSession(clinicId: string, sessionId: string): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  });
}

/**
 * Revoke every session for a user in one statement. Incremented in SQL rather
 * than read-then-write so two concurrent revocations cannot both read the same
 * epoch and leave one of them ineffective.
 */
export async function revokeAllSessionsForUser(clinicId: string, userId: string): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx
      .update(users)
      .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
      .where(eq(users.id, userId));
  });
}

/**
 * Housekeeping for expired and long-revoked rows. Called by a scheduled worker
 * job; expiry is already enforced at read time, so this is only about table size.
 */
export async function pruneExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await getOwnerDb()
    .db.delete(sessions)
    .where(or(lt(sessions.expiresAt, cutoff), and(lt(sessions.lastSeenAt, cutoff), isNull(sessions.revokedAt))))
    .returning({ id: sessions.id });
  return result.length;
}
