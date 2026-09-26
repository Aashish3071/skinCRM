import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  GRANTABLE_CAPABILITIES,
  inviteUserSchema,
  updateUserSchema,
  uuidSchema,
  type Capability,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { generateToken } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { diffSummary, recordAudit } from "../audit";
import { logger } from "../logger";
import { registerRoute } from "../route";
import { sendSystemEmail, webLink } from "../messaging/system-email";
import { revokeAllSessionsForUser } from "../auth/sessions";
import { INVITE_TTL_DAYS } from "../auth/service";

const { users, userBranches, branches, authTokens } = schema;

/** Fields safe to return for a staff listing. No password or MFA material. */
const userSelection = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  role: users.role,
  status: users.status,
  grantedCapabilities: users.grantedCapabilities,
  mfaEnabledAt: users.mfaEnabledAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

export function registerUserRoutes(app: FastifyInstance): void {
  // --- List staff ---------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/users",
    auth: { capability: "users:read" },
    handler: async () => {
      const tx = getTx();
      const rows = await tx
        .select(userSelection)
        .from(users)
        .where(isNull(users.archivedAt))
        .orderBy(asc(users.fullName));
      return { items: rows.map(serializeUser), nextCursor: null };
    },
  });

  // --- Invite -------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/users",
    auth: { capability: "users:write" },
    body: inviteUserSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();

      const existing = await tx
        .select({ id: users.id, archivedAt: users.archivedAt })
        .from(users)
        .where(eq(users.email, body.email))
        .limit(1);
      if (existing[0]) {
        throw conflict("Someone with that email already has an account at this clinic.", {
          email: ["Already in use"],
        });
      }

      await assertBranchesBelongToClinic(body.branchIds);

      const inserted = await tx
        .insert(users)
        .values({
          clinicId: context.clinicId!,
          email: body.email,
          fullName: body.fullName,
          role: body.role,
          status: "invited",
          // No password yet; set when the invitation is accepted.
          passwordHash: null,
        })
        .returning(userSelection);
      const user = inserted[0]!;

      if (body.branchIds.length > 0) {
        await tx.insert(userBranches).values(
          body.branchIds.map((branchId) => ({ clinicId: context.clinicId!, userId: user.id, branchId })),
        );
      }

      const { token, tokenHash } = generateToken(32);
      await tx.insert(authTokens).values({
        clinicId: context.clinicId!,
        userId: user.id,
        purpose: "invite",
        tokenHash,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      });

      await recordAudit({
        action: "user_invited",
        entityType: "user",
        entityId: user.id,
        changeSummary: { role: body.role, branchCount: body.branchIds.length },
      });

      await sendSystemEmail({
        to: body.email,
        subject: "You've been invited to SkinCRM",
        text: `Hello,\n\nYou've been invited to join your clinic's SkinCRM workspace. Set up your account here:\n\n${webLink(`/accept-invite?token=${encodeURIComponent(token)}`)}\n\nThis link expires in ${INVITE_TTL_DAYS} days. If you weren't expecting it, you can ignore this email.`,
      });
      logger.debug({ userId: user.id }, "User invited");
      if (process.env.NODE_ENV === "development") {
        // eslint-disable-next-line no-console -- development affordance only
        console.log(`[dev] invite token for ${body.email}: ${token}`);
      }

      return serializeUser(user);
    },
  });

  // --- Update -------------------------------------------------------------
  registerRoute(app, {
    method: "PATCH",
    url: "/users/:id",
    auth: { capability: "users:write" },
    params: z.object({ id: uuidSchema }),
    body: updateUserSchema,
    handler: async ({ params, body }) => {
      const context = getContext();
      const tx = getTx();

      const found = await tx.select().from(users).where(eq(users.id, params.id)).limit(1);
      const before = found[0];
      // RLS already confines this to the caller's clinic, so a miss means the row
      // either does not exist or belongs to another tenant. Same answer either way.
      if (!before) throw notFound("No such user.");

      if (body.grantedCapabilities) {
        assertCapabilitiesAreGrantable(body.grantedCapabilities);
      }
      if (body.branchIds) {
        await assertBranchesBelongToClinic(body.branchIds);
      }

      // Checked before the last-admin guard: this is about the caller, so it is
      // the more useful message when both would apply.
      if (params.id === context.userId && body.role && body.role !== before.role) {
        throw forbidden("You cannot change your own role. Ask another admin.");
      }

      // Guard against a clinic locking itself out of its own admin functions.
      const losingAdmin =
        before.role === "admin" &&
        ((body.role && body.role !== "admin") || body.status === "suspended");
      if (losingAdmin) {
        const remaining = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "admin"), eq(users.status, "active"), isNull(users.archivedAt)));
        if (remaining.filter((r) => r.id !== params.id).length === 0) {
          throw badRequest("This is the clinic's only active admin. Promote someone else first.");
        }
      }

      const updates: Record<string, unknown> = {};
      if (body.fullName !== undefined) updates.fullName = body.fullName;
      if (body.role !== undefined) updates.role = body.role;
      if (body.status !== undefined) updates.status = body.status;
      if (body.grantedCapabilities !== undefined) updates.grantedCapabilities = body.grantedCapabilities;
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = new Date();
        await tx.update(users).set(updates).where(eq(users.id, params.id));
      }

      if (body.branchIds) {
        await tx.delete(userBranches).where(eq(userBranches.userId, params.id));
        if (body.branchIds.length > 0) {
          await tx.insert(userBranches).values(
            body.branchIds.map((branchId) => ({ clinicId: context.clinicId!, userId: params.id, branchId })),
          );
        }
      }

      await recordAudit({
        action: body.role && body.role !== before.role ? "user_role_changed" : "record_updated",
        entityType: "user",
        entityId: params.id,
        changeSummary: diffSummary(before as unknown as Record<string, unknown>, updates),
      });

      // A narrowed role or a suspension must take effect immediately, not when
      // the user's current session happens to expire.
      const shouldRevoke =
        (body.role !== undefined && body.role !== before.role) ||
        (body.status !== undefined && body.status !== before.status) ||
        body.grantedCapabilities !== undefined;
      if (shouldRevoke) {
        await revokeAllSessionsForUser(context.clinicId!, params.id);
      }

      const after = await tx.select(userSelection).from(users).where(eq(users.id, params.id)).limit(1);
      return serializeUser(after[0]!);
    },
  });

  // --- Archive ------------------------------------------------------------
  registerRoute(app, {
    method: "DELETE",
    url: "/users/:id",
    auth: { capability: "users:write" },
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      const context = getContext();
      const tx = getTx();
      if (params.id === context.userId) {
        throw forbidden("You cannot archive your own account.");
      }
      const found = await tx.select({ role: users.role }).from(users).where(eq(users.id, params.id)).limit(1);
      if (!found[0]) throw notFound("No such user.");

      // Archived, not deleted: their audit entries, notes and assigned records
      // must remain attributable (BRD 7).
      await tx
        .update(users)
        .set({ archivedAt: new Date(), status: "suspended" })
        .where(eq(users.id, params.id));
      await revokeAllSessionsForUser(context.clinicId!, params.id);
      await recordAudit({ action: "user_suspended", entityType: "user", entityId: params.id });
      return null;
    },
  });

  // --- Branches -----------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/branches",
    auth: { capability: "settings:read" },
    handler: async () => {
      const tx = getTx();
      const rows = await tx
        .select({
          id: branches.id,
          name: branches.name,
          timezone: branches.timezone,
          isDefault: branches.isDefault,
        })
        .from(branches)
        .where(isNull(branches.archivedAt))
        .orderBy(asc(branches.name));
      return { items: rows, nextCursor: null };
    },
  });
}

function serializeUser(row: {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
  grantedCapabilities: Capability[];
  mfaEnabledAt: Date | null;
  lastLoginAt: Date | null;
  createdAt?: Date;
}) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    status: row.status,
    grantedCapabilities: row.grantedCapabilities,
    mfaEnabled: row.mfaEnabledAt !== null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

/**
 * Only capabilities the product allows a clinic to delegate may be granted.
 * Without this, an admin could hand any capability to any role and bypass the
 * whole RBAC matrix.
 */
function assertCapabilitiesAreGrantable(requested: readonly Capability[]): void {
  const allowed = new Set<Capability>(GRANTABLE_CAPABILITIES);
  const rejected = requested.filter((capability) => !allowed.has(capability));
  if (rejected.length > 0) {
    throw badRequest("Those permissions cannot be granted individually.", {
      grantedCapabilities: rejected.map((c) => `${c} is not delegatable`),
    });
  }
}

/**
 * RLS means a foreign branch id simply will not be found, so this turns a silent
 * no-op into a clear validation error.
 */
async function assertBranchesBelongToClinic(branchIds: readonly string[]): Promise<void> {
  if (branchIds.length === 0) return;
  const tx = getTx();
  const found = await tx.select({ id: branches.id }).from(branches);
  const valid = new Set(found.map((b) => b.id));
  const unknown = branchIds.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw badRequest("One or more branches do not belong to this clinic.", {
      branchIds: unknown.map((id) => `${id} not found`),
    });
  }
}
