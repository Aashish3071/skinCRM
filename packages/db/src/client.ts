import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv, getRuntimeDatabaseUrl } from "@skincrm/config";
import * as schema from "./schema/index";

export type Database = PostgresJsDatabase<typeof schema>;
/** A tenant-scoped handle. Structurally a Database, but only valid inside withTenant. */
export type TenantDatabase = Database;

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

function createHandle(connectionString: string, max: number): DbHandle {
  const client = postgres(connectionString, {
    max,
    // Fail fast rather than queueing behind a dead database.
    connect_timeout: 10,
    idle_timeout: 30,
    // Never log statement parameters: they carry contact details and message bodies.
    prepare: true,
    onnotice: () => {},
  });
  return {
    db: drizzle(client, { schema }),
    sql: client,
    close: () => client.end({ timeout: 5 }),
  };
}

let runtimeHandle: DbHandle | undefined;
let ownerHandle: DbHandle | undefined;

/**
 * Runtime connection for the api and worker. Uses the non-owner application
 * role, so every query is subject to row-level security. Reaching a tenant
 * table through this handle without `withTenant` returns zero rows by design.
 */
export function getDb(): DbHandle {
  if (!runtimeHandle) {
    runtimeHandle = createHandle(getRuntimeDatabaseUrl(), 20);
  }
  return runtimeHandle;
}

/**
 * Owner connection for migrations, seeds and maintenance scripts. BYPASSES
 * row-level security, so nothing that serves a web request may use it.
 */
export function getOwnerDb(): DbHandle {
  if (!ownerHandle) {
    ownerHandle = createHandle(getEnv().DATABASE_URL, 5);
  }
  return ownerHandle;
}

export const TENANT_SETTING = "app.clinic_id";
export const ACTOR_SETTING = "app.user_id";

/**
 * Run `fn` inside a transaction scoped to one clinic.
 *
 * `set_config(..., is_local => true)` binds the setting to this transaction, so
 * it cannot leak to the next borrower of the pooled connection. Every
 * row-level-security policy reads the same setting, which means a forgotten
 * `where clinicId = ...` is a missing row rather than another tenant's data.
 *
 * Pass `actorUserId` when a request is authenticated; audit triggers record it.
 */
export async function withTenant<T>(
  clinicId: string,
  fn: (tx: TenantDatabase) => Promise<T>,
  options: { actorUserId?: string | null; db?: Database } = {},
): Promise<T> {
  const database = options.db ?? getDb().db;
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${TENANT_SETTING}, ${clinicId}, true)`);
    await tx.execute(sql`select set_config(${ACTOR_SETTING}, ${options.actorUserId ?? ""}, true)`);
    return fn(tx as TenantDatabase);
  });
}

/**
 * Escape hatch for genuinely cross-tenant work: the login lookup by email, the
 * webhook router resolving which clinic an event belongs to, and platform
 * admin tooling. Named to make review easy to grep for.
 *
 * Uses the owner connection, so callers must filter explicitly. Never call this
 * from a route that returns tenant rows to a user.
 */
export async function withoutTenantScope<T>(
  reason: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  if (reason.trim() === "") throw new Error("withoutTenantScope requires a reason for the audit trail");
  return fn(getOwnerDb().db);
}

export async function closeAllConnections(): Promise<void> {
  await Promise.all([runtimeHandle?.close(), ownerHandle?.close()]);
  runtimeHandle = undefined;
  ownerHandle = undefined;
}

export { schema, sql };
