/** `pnpm db:create-clinic`: a new tenant whose first admin can sign in via the invite. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, provisionClinic, schema, sql } from "@skincrm/db";
import { createTestApp, loginAs } from "./helpers";

const { clinics, pipelineStages } = schema;
const tag = Date.now().toString(36);
const slug = `provision-${tag}`;
const adminEmail = `owner.${tag}@provision.test`;
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  const { db } = getOwnerDb();
  // audit_events is append-only for the app; the owner removes the test tenant.
  await db.execute(sql`delete from audit_events where clinic_id in (select id from clinics where slug = ${slug})`).catch(() => {});
  await db.delete(clinics).where(eq(clinics.slug, slug));
  await app.close();
  await closeAllConnections();
});

describe("creating a clinic", () => {
  const input = {
    name: "Provision Test Clinic", slug, timezone: "America/New_York", country: "US",
    branchName: "Main", adminEmail, adminName: "Owner Test",
  };

  it("creates the tenant with its pipeline, and the admin signs in through the invite", async () => {
    const { db } = getOwnerDb();
    const result = await provisionClinic(db, input);
    const stages = await db.select({ id: pipelineStages.id }).from(pipelineStages).where(eq(pipelineStages.clinicId, result.clinicId));
    expect(stages.length).toBeGreaterThan(5);

    const accepted = await app.inject({
      method: "POST", url: "/auth/accept-invite",
      payload: { token: result.inviteToken, fullName: "Owner Test", password: "A-strong-Passw0rd-2026!" },
    });
    expect(accepted.statusCode).toBeLessThan(300);
    const login = await loginAs(app, adminEmail, "A-strong-Passw0rd-2026!");
    expect(login.status).toBe(200);
    // A brand-new admin is asked to set up two-step sign-in or lands signed in.
    expect(["authenticated", "mfa_enrollment_required", "mfa_required"]).toContain(login.body.result);
  });

  it("refuses a duplicate slug and bad input without creating anything", async () => {
    await expect(provisionClinic(getOwnerDb().db, input)).rejects.toThrow(/already exists/);
    await expect(provisionClinic(getOwnerDb().db, { ...input, slug: `x-${tag}`, timezone: "Mars/Olympus" })).rejects.toThrow(/IANA/);
    const leftovers = await getOwnerDb().db.select({ id: clinics.id }).from(clinics).where(eq(clinics.slug, `x-${tag}`));
    expect(leftovers).toHaveLength(0);
  });
});
