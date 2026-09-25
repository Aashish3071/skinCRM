/**
 * Development seed.
 *
 *   pnpm db:seed
 *
 * Creates two clinics on purpose. The second one exists so cross-tenant
 * isolation is testable by hand and in the automated suite: if anything leaks,
 * "Northside Dermatology" shows up where it should not.
 *
 * Idempotent — re-running updates the same rows rather than duplicating them.
 */
import { eq } from "drizzle-orm";
import { DEFAULT_PIPELINE, REASON_REQUIRED_STAGE_CATEGORIES } from "@skincrm/contracts";
import { hashPassword } from "@skincrm/security";
import { getEnv } from "@skincrm/config";
import { closeAllConnections, getOwnerDb, type Database } from "../client";
import { branches, clinics, pipelineStages, userBranches, users } from "../schema/index";

/** Same password for every seeded account. Development only. */
const DEMO_PASSWORD = "ChangeMe-Dev-2026!";

interface SeedUser {
  email: string;
  fullName: string;
  role: "admin" | "front_desk" | "practitioner" | "marketing_analyst";
}

const PRIMARY_CLINIC = {
  slug: "sunshine-skin",
  name: "Sunshine Skin & Laser",
  timezone: "America/New_York",
  country: "US",
  postalAddress: "1200 Biscayne Blvd, Suite 300, Miami, FL 33132",
  supportEmail: "frontdesk@sunshine-skin.test",
  branchName: "Miami — Brickell",
  users: [
    { email: "admin@sunshine-skin.test", fullName: "Dana Okafor", role: "admin" },
    { email: "frontdesk@sunshine-skin.test", fullName: "Priya Raman", role: "front_desk" },
    { email: "frontdesk2@sunshine-skin.test", fullName: "Marco Silva", role: "front_desk" },
    { email: "doctor@sunshine-skin.test", fullName: "Dr. Alex Chen", role: "practitioner" },
    { email: "marketing@sunshine-skin.test", fullName: "Jules Baptiste", role: "marketing_analyst" },
  ] satisfies SeedUser[],
};

/** Control tenant. Nothing in the UI should ever surface its rows to clinic one. */
const SECOND_CLINIC = {
  slug: "northside-derm",
  name: "Northside Dermatology",
  timezone: "America/Chicago",
  country: "US",
  postalAddress: "88 N Wabash Ave, Chicago, IL 60602",
  supportEmail: "hello@northside-derm.test",
  branchName: "Chicago — Loop",
  users: [
    { email: "admin@northside-derm.test", fullName: "Rowan Pierce", role: "admin" },
    { email: "frontdesk@northside-derm.test", fullName: "Sam Whitfield", role: "front_desk" },
  ] satisfies SeedUser[],
};

async function upsertClinic(db: Database, spec: typeof PRIMARY_CLINIC, passwordHash: string) {
  const existing = await db.select().from(clinics).where(eq(clinics.slug, spec.slug)).limit(1);

  const clinicRow =
    existing[0] ??
    (
      await db
        .insert(clinics)
        .values({
          slug: spec.slug,
          name: spec.name,
          timezone: spec.timezone,
          country: spec.country,
          postalAddress: spec.postalAddress,
          supportEmail: spec.supportEmail,
          // Left false deliberately: promotional sending stays off until the
          // clinic's privacy lead approves copy and legal basis (PRD 4.4).
          promotionalSendingApproved: false,
          hipaaStatus: "undetermined",
        })
        .returning()
    )[0]!;

  const clinicId = clinicRow.id;
  console.log(`  clinic ${spec.name} (${clinicId})`);

  // --- Default branch ---
  const existingBranch = await db.select().from(branches).where(eq(branches.clinicId, clinicId)).limit(1);
  const branchRow =
    existingBranch[0] ??
    (
      await db
        .insert(branches)
        .values({ clinicId, name: spec.branchName, isDefault: true })
        .returning()
    )[0]!;

  // --- Pipeline stages ---
  for (const [index, stage] of DEFAULT_PIPELINE.entries()) {
    await db
      .insert(pipelineStages)
      .values({
        clinicId,
        category: stage.category,
        name: stage.name,
        position: index,
        isClosed: stage.isClosed,
        requiresReason: REASON_REQUIRED_STAGE_CATEGORIES.includes(stage.category),
      })
      .onConflictDoNothing({ target: [pipelineStages.clinicId, pipelineStages.category] });
  }
  console.log(`    ${DEFAULT_PIPELINE.length} pipeline stages`);

  // --- Users ---
  for (const spec_user of spec.users) {
    const found = await db
      .select()
      .from(users)
      .where(eq(users.email, spec_user.email))
      .limit(1);

    const userRow =
      found[0] ??
      (
        await db
          .insert(users)
          .values({
            clinicId,
            email: spec_user.email,
            fullName: spec_user.fullName,
            role: spec_user.role,
            status: "active",
            passwordHash,
          })
          .returning()
      )[0]!;

    if (found[0]) {
      // Keep the demo password working after a policy change.
      await db.update(users).set({ passwordHash, status: "active" }).where(eq(users.id, userRow.id));
    }

    await db
      .insert(userBranches)
      .values({ clinicId, userId: userRow.id, branchId: branchRow.id })
      .onConflictDoNothing({ target: [userBranches.userId, userBranches.branchId] });
  }
  console.log(`    ${spec.users.length} users`);

  return { clinicId, branchId: branchRow.id };
}

async function main(): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed a production database. Seed data must never reach an environment with real client records (PRD 9: privacy gate).",
    );
  }

  const { db } = getOwnerDb();
  console.log("Seeding development data");

  // Hash once; Argon2 is intentionally slow and every demo account shares it.
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await upsertClinic(db, PRIMARY_CLINIC, passwordHash);
  await upsertClinic(db, SECOND_CLINIC as typeof PRIMARY_CLINIC, passwordHash);

  console.log("\nSign in with any seeded address, for example:");
  console.log(`  admin@sunshine-skin.test      / ${DEMO_PASSWORD}   (admin)`);
  console.log(`  frontdesk@sunshine-skin.test  / ${DEMO_PASSWORD}   (front desk)`);
  console.log(`  doctor@sunshine-skin.test     / ${DEMO_PASSWORD}   (practitioner)`);
  console.log(`  marketing@sunshine-skin.test  / ${DEMO_PASSWORD}   (marketing analyst)`);
  console.log("\nNorthside Dermatology is the isolation control tenant; its rows must never");
  console.log("appear while signed in to Sunshine Skin & Laser.");
}

main()
  .then(() => closeAllConnections())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Seed failed:", error);
    await closeAllConnections().catch(() => {});
    process.exit(1);
  });
