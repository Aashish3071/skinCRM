import { and, eq, isNull } from "drizzle-orm";
import type { LoginRequest, LoginResponse, SessionUser } from "@skincrm/contracts";
import { schema, withTenant, withoutTenantScope } from "@skincrm/db";
import {
  burnPasswordVerification,
  createTotpEnrollment,
  decryptForClinic,
  encryptForClinic,
  generateRecoveryCodes,
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  normalizeRecoveryCode,
  verifyPassword,
  verifyTotp,
} from "@skincrm/security";
import { getContext } from "../context";
import { badRequest, forbidden, tooManyRequests, unauthorized } from "../errors";
import { logger } from "../logger";
import { recordAudit } from "../audit";
import { createSession, mergeCapabilities, revokeAllSessionsForUser } from "./sessions";

const { users, clinics, userBranches, authTokens, mfaRecoveryCodes } = schema;

/** Failed attempts before the account is temporarily locked. */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

const PASSWORD_RESET_TTL_MINUTES = 60;
const INVITE_TTL_DAYS = 7;

/** Shown for every failed login, whatever the underlying cause. */
const GENERIC_LOGIN_FAILURE = "That email and password combination did not work.";

interface LoginCandidate {
  id: string;
  clinicId: string;
  clinicName: string;
  passwordHash: string | null;
  status: string;
  archivedAt: Date | null;
  clinicArchivedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  mfaSecretEncrypted: string | null;
  mfaEnabledAt: Date | null;
  sessionEpoch: number;
}

/**
 * Sign in.
 *
 * The email lookup is genuinely cross-tenant — the clinic is unknown until we
 * find the account — so it runs through `withoutTenantScope`. Everything after
 * that point is tenant-scoped.
 */
export async function login(
  input: LoginRequest,
  setCookie: (token: string) => void,
): Promise<LoginResponse> {
  const context = getContext();

  const candidates = await withoutTenantScope("login lookup by email across clinics", async (db) =>
    db
      .select({
        id: users.id,
        clinicId: users.clinicId,
        clinicName: clinics.name,
        passwordHash: users.passwordHash,
        status: users.status,
        archivedAt: users.archivedAt,
        clinicArchivedAt: clinics.archivedAt,
        failedLoginCount: users.failedLoginCount,
        lockedUntil: users.lockedUntil,
        mfaSecretEncrypted: users.mfaSecretEncrypted,
        mfaEnabledAt: users.mfaEnabledAt,
        sessionEpoch: users.sessionEpoch,
      })
      .from(users)
      .innerJoin(clinics, eq(clinics.id, users.clinicId))
      .where(
        input.clinicId
          ? and(eq(users.email, input.email), eq(users.clinicId, input.clinicId))
          : eq(users.email, input.email),
      ),
  );

  const usable = candidates.filter(
    (c) => c.passwordHash !== null && c.status === "active" && !c.archivedAt && !c.clinicArchivedAt,
  ) as LoginCandidate[];

  if (usable.length === 0) {
    // Burn an equivalent Argon2 verification so a missing account does not answer
    // measurably faster than a wrong password.
    await burnPasswordVerification();
    logger.info({ correlationId: context.correlationId }, "Login failed: no usable account");
    throw unauthorized(GENERIC_LOGIN_FAILURE);
  }

  // Refuse before doing work if every candidate is locked out.
  const now = new Date();
  const unlocked = usable.filter((c) => !c.lockedUntil || c.lockedUntil <= now);
  if (unlocked.length === 0) {
    throw tooManyRequests(
      `Too many failed attempts. Try again in about ${LOCKOUT_MINUTES} minutes, or reset your password.`,
    );
  }

  const matched: LoginCandidate[] = [];
  for (const candidate of unlocked) {
    if (await verifyPassword(candidate.passwordHash!, input.password)) matched.push(candidate);
  }

  if (matched.length === 0) {
    await Promise.all(unlocked.map((candidate) => registerFailedAttempt(candidate)));
    throw unauthorized(GENERIC_LOGIN_FAILURE);
  }

  // The same address and password at two clinics. The password is already proven,
  // so naming the clinics here discloses nothing new.
  if (matched.length > 1) {
    return {
      result: "clinic_selection_required",
      clinics: matched.map((c) => ({ id: c.clinicId, name: c.clinicName })),
    };
  }

  const user = matched[0]!;

  // --- Second factor ------------------------------------------------------
  if (user.mfaEnabledAt && user.mfaSecretEncrypted) {
    if (input.recoveryCode) {
      await consumeRecoveryCode(user, input.recoveryCode);
    } else if (input.totpCode) {
      const secret = decryptForClinic(user.clinicId, user.mfaSecretEncrypted);
      const { valid } = verifyTotp({ secretBase32: secret, code: input.totpCode });
      if (!valid) {
        await registerFailedAttempt(user);
        throw unauthorized("That code was not accepted. Check your authenticator app and try again.");
      }
    } else {
      // Password was correct; ask for the code without issuing a session.
      return { result: "mfa_required" };
    }
  }

  // --- Success ------------------------------------------------------------
  await withTenant(user.clinicId, async (tx) => {
    const updates: Record<string, unknown> = {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    };
    // Transparently upgrade a hash made with weaker cost parameters.
    if (needsRehash(user.passwordHash!)) {
      updates.passwordHash = await hashPassword(input.password);
    }
    await tx.update(users).set(updates).where(eq(users.id, user.id));
  });

  const { token } = await createSession({
    clinicId: user.clinicId,
    userId: user.id,
    sessionEpoch: user.sessionEpoch,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
  setCookie(token);

  // Populate the context so the audit entry is attributed correctly.
  context.clinicId = user.clinicId;
  context.userId = user.id;
  await recordAudit({
    action: "login_success",
    entityType: "user",
    entityId: user.id,
    clinicId: user.clinicId,
    actorUserId: user.id,
  });

  return { result: "authenticated", user: await loadSessionUser(user.clinicId, user.id) };
}

async function registerFailedAttempt(candidate: LoginCandidate): Promise<void> {
  const nextCount = candidate.failedLoginCount + 1;
  const lock = nextCount >= MAX_FAILED_LOGINS;
  await withTenant(candidate.clinicId, async (tx) => {
    await tx
      .update(users)
      .set({
        failedLoginCount: nextCount,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : candidate.lockedUntil,
      })
      .where(eq(users.id, candidate.id));
  });
  await recordAudit({
    action: "login_failure",
    entityType: "user",
    entityId: candidate.id,
    clinicId: candidate.clinicId,
    actorUserId: null,
    actorLabel: "unauthenticated",
    changeSummary: { attempt: nextCount, locked: lock },
  });
}

async function consumeRecoveryCode(user: LoginCandidate, submitted: string): Promise<void> {
  const codeHash = hashToken(normalizeRecoveryCode(submitted));
  const consumed = await withTenant(user.clinicId, async (tx) =>
    tx
      .update(mfaRecoveryCodes)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(mfaRecoveryCodes.userId, user.id),
          eq(mfaRecoveryCodes.codeHash, codeHash),
          isNull(mfaRecoveryCodes.consumedAt),
        ),
      )
      .returning({ id: mfaRecoveryCodes.id }),
  );
  if (consumed.length === 0) {
    await registerFailedAttempt(user);
    throw unauthorized("That recovery code is not valid or has already been used.");
  }
}

export async function loadSessionUser(clinicId: string, userId: string): Promise<SessionUser> {
  const rows = await withTenant(clinicId, async (tx) =>
    tx
      .select({
        id: users.id,
        clinicId: users.clinicId,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        status: users.status,
        grantedCapabilities: users.grantedCapabilities,
        mfaEnabledAt: users.mfaEnabledAt,
        clinicName: clinics.name,
        clinicTimezone: clinics.timezone,
        clinicCountry: clinics.country,
        clinicLogoUpdatedAt: clinics.logoUpdatedAt,
      })
      .from(users)
      .innerJoin(clinics, eq(clinics.id, users.clinicId))
      .where(eq(users.id, userId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) throw unauthorized();

  const branches = await withTenant(clinicId, async (tx) =>
    tx.select({ branchId: userBranches.branchId }).from(userBranches).where(eq(userBranches.userId, userId)),
  );

  return {
    id: row.id,
    clinicId: row.clinicId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    status: row.status,
    capabilities: mergeCapabilities(row.role, row.grantedCapabilities),
    mfaEnabled: row.mfaEnabledAt !== null,
    branchIds: branches.map((b) => b.branchId),
    clinic: {
      id: row.clinicId,
      name: row.clinicName,
      timezone: row.clinicTimezone,
      country: row.clinicCountry,
        logoVersion: row.clinicLogoUpdatedAt ? row.clinicLogoUpdatedAt.getTime().toString(36) : null,
    },
  };
}

// --- Password reset -------------------------------------------------------

/**
 * Always succeeds from the caller's point of view, whether or not the address
 * exists. Revealing which emails have accounts would turn this into an account
 * enumeration endpoint.
 *
 * Returns the token only so the caller can hand it to the email connector. It is
 * never included in an API response.
 */
export async function requestPasswordReset(email: string): Promise<{ token: string; userId: string } | null> {
  const found = await withoutTenantScope("password reset lookup by email", async (db) =>
    db
      .select({ id: users.id, clinicId: users.clinicId, status: users.status, archivedAt: users.archivedAt })
      .from(users)
      .where(eq(users.email, email))
      .limit(1),
  );
  const user = found[0];
  if (!user || user.status !== "active" || user.archivedAt) return null;

  const { token, tokenHash } = generateToken(32);
  await withTenant(user.clinicId, async (tx) => {
    await tx.insert(authTokens).values({
      clinicId: user.clinicId,
      userId: user.id,
      purpose: "password_reset",
      tokenHash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
    });
  });
  await recordAudit({
    action: "password_reset_requested",
    entityType: "user",
    entityId: user.id,
    clinicId: user.clinicId,
    actorUserId: null,
    actorLabel: "unauthenticated",
  });
  return { token, userId: user.id };
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  const row = await consumeAuthToken(token, "password_reset");
  const passwordHash = await hashPassword(newPassword);

  await withTenant(row.clinicId, async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, row.userId!));
  });
  // Every existing session dies: a reset is how someone recovers a compromised
  // account, so leaving old sessions alive would defeat it.
  await revokeAllSessionsForUser(row.clinicId, row.userId!);
  await recordAudit({
    action: "password_reset_completed",
    entityType: "user",
    entityId: row.userId,
    clinicId: row.clinicId,
    actorUserId: row.userId,
  });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const context = getContext();
  const rows = await withTenant(context.clinicId!, async (tx) =>
    tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, context.userId!)).limit(1),
  );
  const stored = rows[0]?.passwordHash;
  if (!stored || !(await verifyPassword(stored, currentPassword))) {
    throw badRequest("Your current password was not correct.", { currentPassword: ["Incorrect password"] });
  }
  const passwordHash = await hashPassword(newPassword);
  await withTenant(context.clinicId!, async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, context.userId!));
  });
  await revokeAllSessionsForUser(context.clinicId!, context.userId!);
  await recordAudit({ action: "password_reset_completed", entityType: "user", entityId: context.userId });
}

/**
 * Validate a single-use token and mark it consumed in one statement, so two
 * concurrent requests cannot both redeem it.
 */
async function consumeAuthToken(
  token: string,
  purpose: string,
): Promise<{ clinicId: string; userId: string | null; metadata: Record<string, unknown> }> {
  const tokenHash = hashToken(token);
  const rows = await withoutTenantScope(`consume ${purpose} token before the clinic is known`, async (db) =>
    db
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.consumedAt),
        ),
      )
      .returning({
        clinicId: authTokens.clinicId,
        userId: authTokens.userId,
        expiresAt: authTokens.expiresAt,
        metadata: authTokens.metadata,
      }),
  );
  const row = rows[0];
  if (!row) throw badRequest("That link is no longer valid. Request a new one.");
  if (row.expiresAt.getTime() <= Date.now()) {
    throw badRequest("That link has expired. Request a new one.");
  }
  return { clinicId: row.clinicId, userId: row.userId, metadata: row.metadata };
}

// --- MFA -----------------------------------------------------------------

export async function enrollMfa(): Promise<{ secret: string; otpauthUrl: string }> {
  const context = getContext();
  const user = await loadSessionUser(context.clinicId!, context.userId!);
  const enrollment = createTotpEnrollment({ accountEmail: user.email, clinicName: user.clinic.name });

  // Stored immediately but not yet active: mfaEnabledAt is only set once the
  // user proves they can generate a code, so a failed enrolment cannot lock
  // them out.
  await withTenant(context.clinicId!, async (tx) => {
    await tx
      .update(users)
      .set({ mfaSecretEncrypted: encryptForClinic(context.clinicId!, enrollment.secret) })
      .where(eq(users.id, context.userId!));
  });
  return enrollment;
}

export async function confirmMfa(totpCode: string): Promise<{ recoveryCodes: string[] }> {
  const context = getContext();
  const rows = await withTenant(context.clinicId!, async (tx) =>
    tx.select({ secret: users.mfaSecretEncrypted }).from(users).where(eq(users.id, context.userId!)).limit(1),
  );
  const encrypted = rows[0]?.secret;
  if (!encrypted) throw badRequest("Start the setup again — no pending authenticator was found.");

  const secret = decryptForClinic(context.clinicId!, encrypted);
  if (!verifyTotp({ secretBase32: secret, code: totpCode }).valid) {
    throw badRequest("That code was not accepted. Check the time on your device and try again.", {
      totpCode: ["Incorrect code"],
    });
  }

  const { codes, hashes } = generateRecoveryCodes(10);
  await withTenant(context.clinicId!, async (tx) => {
    await tx.update(users).set({ mfaEnabledAt: new Date() }).where(eq(users.id, context.userId!));
    // Replace any codes from a previous enrolment.
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, context.userId!));
    await tx.insert(mfaRecoveryCodes).values(
      hashes.map((codeHash) => ({ clinicId: context.clinicId!, userId: context.userId!, codeHash })),
    );
  });
  await recordAudit({ action: "mfa_enabled", entityType: "user", entityId: context.userId });
  return { recoveryCodes: codes };
}

export async function disableMfa(currentPassword: string): Promise<void> {
  const context = getContext();
  const rows = await withTenant(context.clinicId!, async (tx) =>
    tx
      .select({ passwordHash: users.passwordHash, role: users.role })
      .from(users)
      .where(eq(users.id, context.userId!))
      .limit(1),
  );
  const row = rows[0];
  if (!row?.passwordHash || !(await verifyPassword(row.passwordHash, currentPassword))) {
    throw badRequest("Your current password was not correct.", { currentPassword: ["Incorrect password"] });
  }
  // PRD ID-01 requires MFA to be available for admins; a clinic that has turned
  // it on should not be able to quietly drop it from the admin account.
  if (row.role === "admin") {
    throw forbidden("An admin account cannot remove its own second factor. Ask another admin to reset it.");
  }
  await withTenant(context.clinicId!, async (tx) => {
    await tx
      .update(users)
      .set({ mfaEnabledAt: null, mfaSecretEncrypted: null })
      .where(eq(users.id, context.userId!));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, context.userId!));
  });
  await recordAudit({ action: "mfa_disabled", entityType: "user", entityId: context.userId });
}

// --- Invitations ---------------------------------------------------------

export async function acceptInvite(params: {
  token: string;
  fullName: string;
  password: string;
}): Promise<void> {
  const row = await consumeAuthToken(params.token, "invite");
  if (!row.userId) throw badRequest("That invitation is not valid.");
  const passwordHash = await hashPassword(params.password);
  await withTenant(row.clinicId, async (tx) => {
    await tx
      .update(users)
      .set({ fullName: params.fullName, passwordHash, status: "active" })
      .where(eq(users.id, row.userId!));
  });
  await recordAudit({
    action: "record_updated",
    entityType: "user",
    entityId: row.userId,
    clinicId: row.clinicId,
    actorUserId: row.userId,
    changeSummary: { invitedAccepted: true },
  });
}

export { INVITE_TTL_DAYS };
