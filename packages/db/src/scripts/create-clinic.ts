/**
 * Create a new clinic and invite its first admin. Safe in production.
 *
 *   pnpm db:create-clinic --name "Bright Skin Miami" --slug bright-skin-miami \
 *     --timezone America/New_York --branch "Miami — Brickell" \
 *     --admin-email owner@brightskin.com --admin-name "Jamie Rivera"
 *
 * Optional: --country US (default), --address "…", --support-email "…".
 *
 * Prints a one-time invitation link. Send it to the admin over a channel you
 * trust; they choose their own password and can then invite their staff from
 * Settings → Staff. Run migrations first (`pnpm db:migrate`).
 */
import { parseArgs } from "node:util";
import { getEnv } from "@skincrm/config";
import { closeAllConnections, getOwnerDb } from "../client";
import { provisionClinic, validateProvisionInput } from "../provision";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      timezone: { type: "string", default: "America/New_York" },
      country: { type: "string", default: "US" },
      branch: { type: "string" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
      address: { type: "string" },
      "support-email": { type: "string" },
    },
    strict: true,
  });

  const input = {
    name: values.name ?? "",
    slug: values.slug ?? "",
    timezone: values.timezone!,
    country: (values.country ?? "US").toUpperCase(),
    branchName: values.branch ?? "",
    adminEmail: values["admin-email"] ?? "",
    adminName: values["admin-name"] ?? "",
    postalAddress: values.address,
    supportEmail: values["support-email"],
  };
  const problems = validateProvisionInput(input);
  if (problems.length) {
    console.error(`Cannot create clinic:\n  - ${problems.join("\n  - ")}\n\nSee the usage at the top of packages/db/src/scripts/create-clinic.ts.`);
    process.exitCode = 1;
    return;
  }

  const result = await provisionClinic(getOwnerDb().db, input);
  const link = new URL(`/accept-invite?token=${encodeURIComponent(result.inviteToken)}`, getEnv().PUBLIC_WEB_URL);

  console.log(`Created clinic "${input.name}" (${result.clinicId})`);
  console.log(`  branch:  ${input.branchName}`);
  console.log(`  admin:   ${input.adminName} <${input.adminEmail}> (invited)`);
  console.log("\nSend this link to the admin. It works once and expires");
  console.log(`${result.inviteExpiresAt.toISOString()}:\n\n  ${link}\n`);
  console.log("Nothing else was created: set working hours, consultation types and");
  console.log("integrations from Settings after signing in.");
}

main()
  .then(() => closeAllConnections())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closeAllConnections().catch(() => {});
    process.exit(1);
  });
