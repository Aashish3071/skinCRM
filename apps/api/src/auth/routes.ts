import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  acceptInviteSchema,
  changePasswordSchema,
  loginRequestSchema,
  mfaConfirmSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
} from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { getContext } from "../context";
import { registerRoute } from "../route";
import { logger } from "../logger";
import { recordAudit } from "../audit";
import { SESSION_COOKIE, resolveSession, revokeSession, sessionCookieOptions } from "./sessions";
import {
  acceptInvite,
  changePassword,
  confirmMfa,
  confirmPasswordReset,
  disableMfa,
  enrollMfa,
  loadSessionUser,
  login,
  requestPasswordReset,
} from "./service";

/**
 * Rate limit on the credential endpoints, keyed by IP.
 *
 * Two separate defences, deliberately:
 *   - Per IP (here) stops one host spraying many addresses.
 *   - Per account (`MAX_FAILED_LOGINS` in ./service) stops a targeted attack on
 *     one address, wherever it comes from.
 *
 * Keying this bucket by IP *and* email was the first attempt and does not work:
 * @fastify/rate-limit runs in `onRequest`, before the body is parsed, so
 * `request.body` is undefined and every login collapses into one per-IP bucket.
 * Rather than move rate limiting to `preHandler` just to read the email, the
 * account lockout covers that case and this stays a coarse per-IP cap.
 *
 * 30 in 5 minutes is far above what a clinic front desk does and far below what
 * a credential-stuffing run needs.
 */
const credentialRateLimit = {
  // Effectively disabled under test: the suite makes many deliberate login
  // attempts, and the limiter is verified on its own rather than incidentally
  // throttling unrelated assertions.
  max: getEnv().NODE_ENV === "test" ? 100_000 : 30,
  timeWindow: "5 minutes",
};

export function registerAuthRoutes(app: FastifyInstance): void {
  // --- Sign in ------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/auth/login",
    auth: false,
    body: loginRequestSchema,
    status: 200,
    rateLimit: credentialRateLimit,
    handler: async ({ body, reply }) =>
      login(body, (token) => {
        reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
      }),
  });

  // --- Sign out -----------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/auth/logout",
    // Deliberately public: an expired or already-revoked session should still be
    // able to clear its cookie rather than getting a 401 it cannot act on.
    auth: false,
    status: 204,
    handler: async ({ request, reply }) => {
      const session = await resolveSession(request.cookies[SESSION_COOKIE]);
      if (session) {
        await revokeSession(session.user.clinicId, session.sessionId);
        await recordAudit({
          action: "logout",
          entityType: "user",
          entityId: session.user.id,
          clinicId: session.user.clinicId,
          actorUserId: session.user.id,
        });
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return null;
    },
  });

  // --- Who am I -----------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/auth/session",
    auth: {},
    handler: async ({ ctx }) => loadSessionUser(ctx.clinicId!, ctx.userId!),
  });

  // --- Password reset -----------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/auth/password-reset",
    auth: false,
    body: passwordResetRequestSchema,
    status: 202,
    rateLimit: credentialRateLimit,
    handler: async ({ body }) => {
      const issued = await requestPasswordReset(body.email);
      if (issued) {
        // TODO(phase 4): hand the token to the email connector. Until the
        // messaging layer exists, log it at debug so development can complete
        // the flow. `logger` redacts `token`, so print the link explicitly and
        // only outside production.
        logger.debug({ userId: issued.userId }, "Password reset requested");
        if (process.env.NODE_ENV === "development") {
          // eslint-disable-next-line no-console -- development affordance only
          console.log(`[dev] password reset token for ${body.email}: ${issued.token}`);
        }
      }
      // Identical response either way: whether an address has an account is not
      // something this endpoint should disclose.
      return { status: "sent" };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/password-reset/confirm",
    auth: false,
    body: passwordResetConfirmSchema,
    status: 204,
    rateLimit: { max: 10, timeWindow: "5 minutes" },
    handler: async ({ body }) => {
      await confirmPasswordReset(body.token, body.password);
      return null;
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/change-password",
    auth: {},
    body: changePasswordSchema,
    status: 204,
    handler: async ({ body, reply }) => {
      await changePassword(body.currentPassword, body.newPassword);
      // Changing a password revokes every session including this one.
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return null;
    },
  });

  // --- MFA ----------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/auth/mfa/enroll",
    auth: {},
    status: 200,
    handler: async () => enrollMfa(),
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/mfa/confirm",
    auth: {},
    body: mfaConfirmSchema,
    status: 200,
    handler: async ({ body }) => confirmMfa(body.totpCode),
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/mfa/disable",
    auth: {},
    body: z.object({ currentPassword: z.string().min(1).max(256) }),
    status: 204,
    handler: async ({ body }) => {
      await disableMfa(body.currentPassword);
      return null;
    },
  });

  // --- Invitations --------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/auth/accept-invite",
    auth: false,
    body: acceptInviteSchema,
    status: 204,
    rateLimit: { max: 10, timeWindow: "5 minutes" },
    handler: async ({ body }) => {
      await acceptInvite(body);
      return null;
    },
  });
}

/** Re-exported for the users module, which needs the same context helper. */
export { getContext };
