/**
 * Full database bring-up, safe to run repeatedly.
 *
 *   pnpm db:migrate
 *
 * Order matters:
 *   1. extensions   - pgcrypto powers the gen_random_uuid() column defaults
 *   2. app role     - must exist before the RLS script grants it privileges
 *   3. migrations   - the generated Drizzle SQL
 *   4. RLS          - re-applied every time so new tables cannot be left open
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getEnv } from "@skincrm/config";
import { closeAllConnections, getOwnerDb } from "../client";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function runSqlFile(relativePath: string): Promise<void> {
  const { sql } = getOwnerDb();
  const contents = await readFile(join(packageRoot, relativePath), "utf8");
  console.log(`  → ${relativePath}`);
  await sql.unsafe(contents);
}

async function ensureAppRole(): Promise<void> {
  const env = getEnv();
  const { sql } = getOwnerDb();
  const roleName = "skincrm_app";

  // CREATE ROLE cannot take bind parameters, so build the statement with
  // server-side quoting rather than string concatenation.
  const [quoted] = await sql<{ pw: string }[]>`select quote_literal(${env.DATABASE_APP_PASSWORD}) as pw`;
  const passwordLiteral = quoted!.pw;

  const existing = await sql<{ exists: boolean }[]>`
    select exists (select 1 from pg_roles where rolname = ${roleName}) as exists
  `;

  if (existing[0]!.exists) {
    console.log(`  → role ${roleName} exists, syncing password`);
    await sql.unsafe(`alter role ${roleName} with login password ${passwordLiteral}`);
  } else {
    console.log(`  → creating role ${roleName}`);
    await sql.unsafe(
      // NOBYPASSRLS is the default, but state it so the intent survives a future edit.
      `create role ${roleName} with login nosuperuser nocreatedb nocreaterole nobypassrls password ${passwordLiteral}`,
    );
  }

  const [db] = await sql<{ current_database: string }[]>`select current_database()`;
  await sql.unsafe(`grant connect on database ${quoteIdent(db!.current_database)} to ${roleName}`);
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function main(): Promise<void> {
  const env = getEnv();
  console.log(`Migrating ${redactUrl(env.DATABASE_URL)}`);

  console.log("1/4 extensions");
  await runSqlFile("sql/010_extensions.sql");

  console.log("2/4 application role");
  await ensureAppRole();

  console.log("3/4 schema migrations");
  const { db } = getOwnerDb();
  await migrate(db, { migrationsFolder: join(packageRoot, "drizzle") });

  console.log("4/4 row-level security");
  await runSqlFile("sql/900_rls.sql");

  console.log("Done.");
}

function redactUrl(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

main()
  .then(() => closeAllConnections())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Migration failed:", error);
    await closeAllConnections().catch(() => {});
    process.exit(1);
  });
