/**
 * Drop and rebuild the public schema, then migrate and seed.
 *
 *   pnpm db:reset
 *
 * Destructive by design, and refused outside development so it can never be
 * pointed at an environment holding real client records.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "@skincrm/config";
import { closeAllConnections, getOwnerDb } from "../client";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function main(): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === "production") {
    throw new Error("db:reset is refused when NODE_ENV=production");
  }
  if (/amazonaws|azure|gcp|render|railway|supabase|neon/i.test(env.DATABASE_URL)) {
    throw new Error(
      `DATABASE_URL points at what looks like a hosted database. Refusing to drop it.\n` +
        `If this is genuinely a throwaway environment, drop the schema by hand.`,
    );
  }

  const { sql } = getOwnerDb();
  console.log("Dropping public schema");
  await sql.unsafe(`drop schema public cascade; create schema public;`);
  // The app role's privileges lived on the dropped objects; 900_rls.sql re-grants them.
  await sql.unsafe(`grant usage on schema public to skincrm_app;`).catch(() => {
    // Role may not exist yet on a first-ever run; migrate creates it.
  });
  await closeAllConnections();

  run("pnpm", ["run", "migrate"]);
  run("pnpm", ["run", "seed"]);
  console.log("Reset complete.");
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Reset failed:", error);
    await closeAllConnections().catch(() => {});
    process.exit(1);
  });
