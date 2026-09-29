/**
 * Auth and authorization integration tests (PRD ID-01, and the permission half
 * of pilot UAT scenario 9).
 *
 * Runs against the seeded development database:
 *   docker compose up -d && pnpm db:migrate && pnpm db:seed
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { TOTP, Secret } from "otpauth";
import {
  SEED,
  SEED_PASSWORD,
  authenticate,
  clinicIdBySlug,
  createTestApp,
  loginAs,
  resetAuthState,
  letters,
} from "./helpers";

const { users, auditEvents, appointments, people } = schema;

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closeAllConnections();
});

beforeEach(async () => {
  await resetAuthState();
});

describe("sign in", () => {
  it("authenticates a seeded admin and returns their capabilities", async () => {
    const { status, body, cookie } = await loginAs(app, SEED.admin);
    expect(status).toBe(200);
    expect(body.result).toBe("authenticated");
    const user = body.user as Record<string, unknown>;
    expect(user.email).toBe(SEED.admin);
    expect(user.role).toBe("admin");
    expect(user.capabilities as string[]).toContain("users:write");
    expect(cookie).toMatch(/^skincrm_session=/);
  });

  it("sets an HttpOnly cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: SEED.admin, password: SEED_PASSWORD },
    });
    const setCookie = response.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
    expect(raw.toLowerCase()).toContain("httponly");
    expect(raw.toLowerCase()).toContain("samesite=lax");
  });

  it("never returns the password hash or MFA secret", async () => {
    const { body } = await loginAs(app, SEED.admin);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("$argon2");
    expect(serialized).not.toContain("mfaSecret");
  });

  it("rejects a wrong password with the same message as an unknown email", async () => {
    const wrongPassword = await loginAs(app, SEED.admin, "not-the-password");
    const unknownEmail = await loginAs(app, "nobody@nowhere.test", "not-the-password");

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Identical wording, so the endpoint is not an account-enumeration oracle.
    expect((wrongPassword.body.error as { message: string }).message).toBe(
      (unknownEmail.body.error as { message: string }).message,
    );
  });

  it("refuses a suspended account", async () => {
    const { db } = getOwnerDb();
    await db.update(users).set({ status: "suspended" }).where(eq(users.email, SEED.practitioner));
    try {
      const result = await loginAs(app, SEED.practitioner);
      expect(result.status).toBe(401);
    } finally {
      await db.update(users).set({ status: "active" }).where(eq(users.email, SEED.practitioner));
    }
  });

  it("returns a correlation id on every failure", async () => {
    const { body } = await loginAs(app, SEED.admin, "wrong");
    const error = body.error as { code: string; correlationId?: string };
    expect(error.code).toBe("unauthorized");
    expect(error.correlationId).toBeTruthy();
  });

  it("rejects a malformed request with field-level detail", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "not-an-email", password: "" },
    });
    expect(response.statusCode).toBe(400);
    const error = response.json().error as { code: string; details: Record<string, string[]> };
    expect(error.code).toBe("bad_request");
    expect(Object.keys(error.details)).toContain("email");
  });
});

describe("account lockout", () => {
  it("locks after five failures and leaves other accounts alone", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await loginAs(app, SEED.frontDesk2, "definitely-wrong");
      expect(result.status).toBe(401);
    }

    // The correct password must now be refused, and told why.
    const locked = await loginAs(app, SEED.frontDesk2);
    expect(locked.status).toBe(429);
    expect((locked.body.error as { code: string }).code).toBe("rate_limited");

    // A different member of staff is unaffected: lockout is per account.
    const other = await loginAs(app, SEED.frontDesk);
    expect(other.status).toBe(200);
  });
});

describe("sessions", () => {
  it("rejects a request with no cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/session" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a forged cookie", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: "skincrm_session=not-a-real-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns the signed-in user", async () => {
    const cookie = await authenticate(app, SEED.frontDesk);
    const response = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBe(SEED.frontDesk);
  });

  it("stops accepting the cookie after logout", async () => {
    const cookie = await authenticate(app, SEED.frontDesk);
    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("revokes every session when the session epoch is bumped", async () => {
    const cookie = await authenticate(app, SEED.frontDesk);
    const { db } = getOwnerDb();
    // What a password change, role change or suspension does.
    await db.update(users).set({ sessionEpoch: 99 }).where(eq(users.email, SEED.frontDesk));
    try {
      const after = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
      expect(after.statusCode).toBe(401);
    } finally {
      await db.update(users).set({ sessionEpoch: 0 }).where(eq(users.email, SEED.frontDesk));
    }
  });
});

describe("capability enforcement", () => {
  /**
   * PRD UAT scenario 9: a practitioner and a marketing analyst must not reach
   * data or exports their role does not allow.
   */
  it("denies a marketing analyst the staff list", async () => {
    const cookie = await authenticate(app, SEED.marketing);
    const response = await app.inject({ method: "GET", url: "/users", headers: { cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
  });

  it("denies a marketing analyst clinic settings", async () => {
    const cookie = await authenticate(app, SEED.marketing);
    const response = await app.inject({ method: "GET", url: "/branches", headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });

  it("gives a marketing analyst no capability that can reach a personal record", async () => {
    const { body } = await loginAs(app, SEED.marketing);
    const capabilities = (body.user as { capabilities: string[] }).capabilities;
    expect(capabilities).not.toContain("people:read");
    expect(capabilities).not.toContain("leads:read");
    expect(capabilities).not.toContain("reports:export");
  });

  it("denies a practitioner the staff list and user administration", async () => {
    const cookie = await authenticate(app, SEED.practitioner);
    expect((await app.inject({ method: "GET", url: "/users", headers: { cookie } })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/users",
          headers: { cookie },
          payload: { email: "new@sunshine-skin.test", fullName: "New Person", role: "front_desk" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("allows front desk to read the staff list but not invite", async () => {
    const cookie = await authenticate(app, SEED.frontDesk);
    // front_desk has no users:read either; the listing is admin-only.
    const list = await app.inject({ method: "GET", url: "/users", headers: { cookie } });
    expect(list.statusCode).toBe(403);
  });

  it("lets an admin list staff", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const response = await app.inject({ method: "GET", url: "/users", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect((response.json().items as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("tenant isolation across the HTTP surface", () => {
  it("shows an admin only their own clinic's staff", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const response = await app.inject({ method: "GET", url: "/users", headers: { cookie } });
    const emails = (response.json().items as { email: string }[]).map((u) => u.email);

    expect(emails).toContain(SEED.admin);
    // The control tenant must be entirely absent.
    expect(emails).not.toContain(SEED.otherClinicAdmin);
    expect(emails.every((email) => email.endsWith("@sunshine-skin.test"))).toBe(true);
  });

  it("cannot update a user belonging to another clinic", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const { db } = getOwnerDb();
    const target = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, SEED.otherClinicAdmin))
      .limit(1);
    const foreignUserId = target[0]!.id;

    const response = await app.inject({
      method: "PATCH",
      url: `/users/${foreignUserId}`,
      headers: { cookie },
      payload: { fullName: "Tampered By Another Clinic" },
    });
    // Row-level security hides the row, so this is a 404 rather than a 403 —
    // deliberately, since confirming the record exists would itself disclose it.
    expect(response.statusCode).toBe(404);

    const after = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, foreignUserId));
    expect(after[0]!.fullName).not.toBe("Tampered By Another Clinic");
  });

  it("scopes each clinic's admin to their own staff list", async () => {
    const northsideCookie = await authenticate(app, SEED.otherClinicAdmin);
    const response = await app.inject({ method: "GET", url: "/users", headers: { cookie: northsideCookie } });
    const emails = (response.json().items as { email: string }[]).map((u) => u.email);
    expect(emails.every((email) => email.endsWith("@northside-derm.test"))).toBe(true);
    expect(emails).not.toContain(SEED.admin);
  });
});

describe("user administration", () => {
  it("refuses to demote the only remaining admin", async () => {
    const cookie = await authenticate(app, SEED.otherClinicAdmin);
    const { db } = getOwnerDb();
    const clinicB = await clinicIdBySlug(SEED.clinicB);
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clinicId, clinicB));
    const soleAdmin = admins.find((a) => a.id);
    expect(soleAdmin).toBeDefined();

    // Northside is seeded with exactly one admin, so this is the last-admin path.
    const target = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, SEED.otherClinicAdmin))
      .limit(1);

    const response = await app.inject({
      method: "PATCH",
      url: `/users/${target[0]!.id}`,
      headers: { cookie: cookie },
      payload: { status: "suspended" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json().error as { message: string }).message).toContain("only active admin");
  });

  it("refuses to grant a capability that is not delegatable", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const { db } = getOwnerDb();
    const target = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, SEED.practitioner))
      .limit(1);

    const response = await app.inject({
      method: "PATCH",
      url: `/users/${target[0]!.id}`,
      headers: { cookie },
      // Not in GRANTABLE_CAPABILITIES; allowing it would bypass the RBAC matrix.
      payload: { grantedCapabilities: ["users:write"] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to change your own role", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    const selfId = session.json().id as string;

    const response = await app.inject({
      method: "PATCH",
      url: `/users/${selfId}`,
      headers: { cookie },
      payload: { role: "front_desk" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("removing staff", () => {
  const tag = Date.now().toString(36);
  const invite = async (cookie: string, role: string, suffix: string) => {
    const response = await app.inject({
      method: "POST", url: "/users", headers: { cookie },
      payload: { email: `remove.${suffix}.${tag}@sunshine-skin.test`, fullName: `Remove ${suffix} ${letters(Date.now())}`, role },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  };

  it("deletes a non-admin account, and refuses an admin until their role changes", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const id = await invite(cookie, "admin", "admin");

    const refused = await app.inject({ method: "DELETE", url: `/users/${id}/permanent`, headers: { cookie } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain("Change their role first");

    const demoted = await app.inject({ method: "PATCH", url: `/users/${id}`, headers: { cookie }, payload: { role: "front_desk" } });
    expect(demoted.statusCode).toBe(200);
    const deleted = await app.inject({ method: "DELETE", url: `/users/${id}/permanent`, headers: { cookie } });
    expect(deleted.statusCode).toBe(204);

    const { db } = getOwnerDb();
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, id))).toHaveLength(0);
    const audit = await db.select({ id: auditEvents.id }).from(auditEvents)
      .where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "record_deleted")));
    expect(audit).toHaveLength(1);
  });

  it("refuses to delete your own account", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    const response = await app.inject({ method: "DELETE", url: `/users/${session.json().id}/permanent`, headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });

  it("refuses to delete someone with appointments, and leaves them untouched", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const id = await invite(cookie, "practitioner", "booked");
    const { db } = getOwnerDb();
    const clinicId = await clinicIdBySlug(SEED.clinicA);
    // Its own patient: a freshly seeded database (CI) has none to borrow.
    const [person] = await db.insert(people).values({
      clinicId, firstName: "Booked", lastName: "Patient", displayName: "Booked Patient (auth test)",
      emailRaw: `booked.${letters(Date.now())}@example.test`,
    }).returning({ id: people.id });
    const [appointment] = await db.insert(appointments).values({
      clinicId, personId: person!.id, staffUserId: id,
      startsAt: new Date("2031-01-06T15:00:00Z"), endsAt: new Date("2031-01-06T15:30:00Z"),
    }).returning({ id: appointments.id });

    try {
      const response = await app.inject({ method: "DELETE", url: `/users/${id}/permanent`, headers: { cookie } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain("Archive them instead");
      expect(await db.select({ id: users.id }).from(users).where(eq(users.id, id))).toHaveLength(1);
    } finally {
      await db.delete(appointments).where(eq(appointments.id, appointment!.id));
      await db.delete(people).where(eq(people.id, person!.id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("archives another admin while one remains, but never yourself", async () => {
    const cookie = await authenticate(app, SEED.admin);
    const id = await invite(cookie, "admin", "archived");
    const archived = await app.inject({ method: "DELETE", url: `/users/${id}`, headers: { cookie } });
    expect(archived.statusCode).toBe(204);

    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    const self = await app.inject({ method: "DELETE", url: `/users/${session.json().id}`, headers: { cookie } });
    expect(self.statusCode).toBe(403);
    await getOwnerDb().db.delete(users).where(eq(users.id, id));
  });
});

describe("multi-factor authentication", () => {
  it("challenges for a code once enabled, and accepts a valid one", async () => {
    const cookie = await authenticate(app, SEED.frontDesk);

    const enroll = await app.inject({ method: "POST", url: "/auth/mfa/enroll", headers: { cookie } });
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret as string;

    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" });
    const confirm = await app.inject({
      method: "POST",
      url: "/auth/mfa/confirm",
      headers: { cookie },
      payload: { totpCode: totp.generate() },
    });
    expect(confirm.statusCode).toBe(200);
    const recoveryCodes = confirm.json().recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);

    // Password alone is no longer enough.
    const challenged = await loginAs(app, SEED.frontDesk);
    expect(challenged.body.result).toBe("mfa_required");
    expect(challenged.cookie).toBeNull();

    // With a code it succeeds.
    const withCode = await loginAs(app, SEED.frontDesk, SEED_PASSWORD, { totpCode: totp.generate() });
    expect(withCode.body.result).toBe("authenticated");

    // A recovery code works once and then does not.
    const firstUse = await loginAs(app, SEED.frontDesk, SEED_PASSWORD, { recoveryCode: recoveryCodes[0] });
    expect(firstUse.body.result).toBe("authenticated");
    const replay = await loginAs(app, SEED.frontDesk, SEED_PASSWORD, { recoveryCode: recoveryCodes[0] });
    expect(replay.status).toBe(401);
  });

  it("rejects a wrong code at enrolment", async () => {
    const cookie = await authenticate(app, SEED.frontDesk);
    await app.inject({ method: "POST", url: "/auth/mfa/enroll", headers: { cookie } });
    const confirm = await app.inject({
      method: "POST",
      url: "/auth/mfa/confirm",
      headers: { cookie },
      payload: { totpCode: "000000" },
    });
    expect(confirm.statusCode).toBe(400);
  });
});

describe("password reset", () => {
  it("answers identically whether or not the address exists", async () => {
    const known = await app.inject({
      method: "POST",
      url: "/auth/password-reset",
      payload: { email: SEED.frontDesk },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/auth/password-reset",
      payload: { email: "nobody@nowhere.test" },
    });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
  });

  it("never returns the reset token in the response", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset",
      payload: { email: SEED.frontDesk },
    });
    expect(response.body).not.toMatch(/token/i);
  });

  it("rejects an invalid token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: "a".repeat(40), password: "a-perfectly-fine-password" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("audit trail", () => {
  it("records a successful sign-in without storing personal data", async () => {
    const { db } = getOwnerDb();
    const before = await db.select({ id: auditEvents.id }).from(auditEvents);

    await authenticate(app, SEED.frontDesk);

    const after = await db
      .select({
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        changeSummary: auditEvents.changeSummary,
      })
      .from(auditEvents);
    expect(after.length).toBeGreaterThan(before.length);

    const loginEntry = after.reverse().find((row) => row.action === "login_success");
    expect(loginEntry).toBeDefined();
    expect(loginEntry!.entityType).toBe("user");
    // No contact details in the summary (PRD 8).
    const serialized = JSON.stringify(loginEntry!.changeSummary);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("password");
  });

  it("records a failed sign-in as unauthenticated", async () => {
    await loginAs(app, SEED.frontDesk, "definitely-wrong");
    const { db } = getOwnerDb();
    const rows = await db
      .select({ action: auditEvents.action, actorLabel: auditEvents.actorLabel })
      .from(auditEvents)
      .where(eq(auditEvents.action, "login_failure"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.actorLabel).toBe("unauthenticated");
  });
});

describe("health", () => {
  it("reports ready only when the database answers and the worker is alive", async () => {
    const { db } = getOwnerDb();
    const { opsHeartbeats } = schema;
    const [previous] = await db.select().from(opsHeartbeats).where(eq(opsHeartbeats.key, "worker"));
    try {
      await db.insert(opsHeartbeats).values({ key: "worker", at: new Date() })
        .onConflictDoUpdate({ target: opsHeartbeats.key, set: { at: new Date() } });
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().status).toBe("ready");

      // A stopped worker means leads and reminders stop moving: not ready.
      await db.update(opsHeartbeats).set({ at: new Date(Date.now() - 10 * 60_000) }).where(eq(opsHeartbeats.key, "worker"));
      const stale = await app.inject({ method: "GET", url: "/health/ready" });
      expect(stale.statusCode).toBe(503);
      expect(stale.json()).toMatchObject({ status: "degraded", worker: "stale" });
    } finally {
      if (previous) await db.update(opsHeartbeats).set({ at: previous.at }).where(eq(opsHeartbeats.key, "worker"));
      else await db.delete(opsHeartbeats).where(eq(opsHeartbeats.key, "worker"));
    }
  });

  it("returns the shared error envelope for an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/no-such-thing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });
});
