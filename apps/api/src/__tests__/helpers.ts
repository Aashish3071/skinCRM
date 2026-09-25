import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getOwnerDb, schema } from "@skincrm/db";
import { buildApp } from "../app";

const { users, clinics } = schema;

/** The password every seeded account shares. Kept in step with packages/db seed. */
export const SEED_PASSWORD = "ChangeMe-Dev-2026!";

export const SEED = {
  clinicA: "sunshine-skin",
  clinicB: "northside-derm",
  admin: "admin@sunshine-skin.test",
  frontDesk: "frontdesk@sunshine-skin.test",
  frontDesk2: "frontdesk2@sunshine-skin.test",
  practitioner: "doctor@sunshine-skin.test",
  marketing: "marketing@sunshine-skin.test",
  otherClinicAdmin: "admin@northside-derm.test",
} as const;

export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/**
 * Clear lockout counters and any MFA left behind by another test, so each test
 * starts from a known state without needing a full reseed.
 */
export async function resetAuthState(): Promise<void> {
  const { db } = getOwnerDb();
  await db.update(users).set({
    failedLoginCount: 0,
    lockedUntil: null,
    mfaEnabledAt: null,
    mfaSecretEncrypted: null,
  });
}

export async function clinicIdBySlug(slug: string): Promise<string> {
  const { db } = getOwnerDb();
  const rows = await db.select({ id: clinics.id }).from(clinics).where(eq(clinics.slug, slug)).limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error(`Seed clinic "${slug}" is missing. Run pnpm db:seed.`);
  return id;
}

export interface LoginResult {
  status: number;
  body: Record<string, unknown>;
  /** Cookie header value to replay on later requests, or null. */
  cookie: string | null;
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string = SEED_PASSWORD,
  extra: Record<string, unknown> = {},
): Promise<LoginResult> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password, ...extra },
  });
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = typeof raw === "string" ? raw.split(";")[0]! : null;
  return { status: response.statusCode, body: response.json(), cookie };
}

/** Sign in and return the cookie, failing loudly if authentication did not happen. */
export async function authenticate(app: FastifyInstance, email: string): Promise<string> {
  const result = await loginAs(app, email);
  if (result.status !== 200 || result.body.result !== "authenticated" || !result.cookie) {
    throw new Error(`Could not sign in as ${email}: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.cookie;
}
