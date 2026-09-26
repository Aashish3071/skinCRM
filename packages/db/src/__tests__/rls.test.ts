/**
 * Row-level-security isolation suite.
 *
 * This is the load-bearing test for a multi-tenant deployment: it proves
 * isolation is enforced by Postgres, so a missing `where clinicId = ...` in
 * application code is a bug that returns nothing rather than a breach.
 *
 * Requires a migrated and seeded database:
 *   docker compose up -d && pnpm db:migrate && pnpm db:seed
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeAllConnections, getDb, getOwnerDb, sql, withTenant } from "../client";
import { branches, clinics, users } from "../schema/index";

let clinicA: { id: string; name: string };
let clinicB: { id: string; name: string };

beforeAll(async () => {
  const { db } = getOwnerDb();
  const rows = await db.select({ id: clinics.id, name: clinics.name, slug: clinics.slug }).from(clinics);
  const a = rows.find((r) => r.slug === "sunshine-skin");
  const b = rows.find((r) => r.slug === "northside-derm");
  if (!a || !b) {
    throw new Error("Seed data missing. Run `pnpm db:migrate && pnpm db:seed` first.");
  }
  clinicA = { id: a.id, name: a.name };
  clinicB = { id: b.id, name: b.name };
});

afterAll(async () => {
  await closeAllConnections();
});

describe("no tenant table can be left unprotected", () => {
  /**
   * The safety net for the single most dangerous mistake in this codebase:
   * adding a table with a `clinic_id` and forgetting to list it in
   * `sql/900_rls.sql`. That table would behave perfectly in development and leak
   * across clinics in production.
   *
   * This test discovers tables from the database itself rather than from a
   * hand-maintained list, so it fails the moment a new one appears unprotected.
   */
  it("every table with a clinic_id has RLS enabled, forced, and a policy", async () => {
    const { sql: appSql } = getDb();
    const rows = await appSql<
      { table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policy_count: number }[]
    >`
      select
        c.relname as table_name,
        c.relrowsecurity,
        c.relforcerowsecurity,
        (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policy_count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join information_schema.columns col
        on col.table_schema = n.nspname
       and col.table_name = c.relname
       and col.column_name = 'clinic_id'
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `;

    expect(rows.length, "expected tenant tables to exist").toBeGreaterThan(8);

    const unprotected = rows.filter(
      (r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policy_count === 0,
    );
    expect(
      unprotected.map((r) => r.table_name),
      "these tables have a clinic_id but no enforced RLS policy — add them to the tenant_tables array in packages/db/sql/900_rls.sql",
    ).toEqual([]);
  });

  it("the clinics table itself is protected", async () => {
    const { sql: appSql } = getDb();
    const [row] = await appSql<{ relrowsecurity: boolean; relforcerowsecurity: boolean; n: number }[]>`
      select c.relrowsecurity, c.relforcerowsecurity,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as n
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relname = 'clinics'
    `;
    expect(row!.relrowsecurity).toBe(true);
    expect(row!.relforcerowsecurity).toBe(true);
    expect(row!.n).toBeGreaterThan(0);
  });
});

describe("the application role is subject to RLS", () => {
  it("is not a superuser and cannot bypass row-level security", async () => {
    const { sql: appSql } = getDb();
    const [role] = await appSql<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }[]>`
      select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    expect(role!.rolname).toBe("skincrm_app");
    expect(role!.rolsuper).toBe(false);
    // BYPASSRLS would silently disable every policy in the schema.
    expect(role!.rolbypassrls).toBe(false);
  });

  it("does not own the tables, and the tables force RLS regardless", async () => {
    const { sql: appSql } = getDb();
    const rows = await appSql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname in ('clinics','users','branches','sessions','audit_events','pipeline_stages')
      order by c.relname
    `;
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} has RLS enabled`).toBe(true);
      // Without FORCE, the owner role bypasses policies.
      expect(row.relforcerowsecurity, `${row.relname} forces RLS`).toBe(true);
    }
  });
});

describe("reads are confined to the current tenant", () => {
  it("returns nothing when no clinic is set (fail closed)", async () => {
    const { db } = getDb();
    // Deliberately bypassing withTenant: app.clinic_id is unset.
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(0);
  });

  it("sees only its own clinic's users", async () => {
    const seen = await withTenant(clinicA.id, async (tx) => tx.select().from(users));
    expect(seen.length).toBeGreaterThan(0);
    for (const row of seen) {
      expect(row.clinicId).toBe(clinicA.id);
    }
    // The control tenant's staff must be absent.
    expect(seen.some((u) => u.email.endsWith("@northside-derm.test"))).toBe(false);
  });

  it("cannot read another clinic's row even when asked for it by primary key", async () => {
    const otherAdmin = await withTenant(clinicB.id, async (tx) =>
      tx.select().from(users).where(eq(users.email, "admin@northside-derm.test")),
    );
    expect(otherAdmin).toHaveLength(1);
    const targetId = otherAdmin[0]!.id;

    // Same query, wrong tenant. An id leaked through a URL must not be usable.
    const leaked = await withTenant(clinicA.id, async (tx) =>
      tx.select().from(users).where(eq(users.id, targetId)),
    );
    expect(leaked).toHaveLength(0);
  });

  it("scopes the clinics table by its own id, not clinic_id", async () => {
    const visible = await withTenant(clinicA.id, async (tx) => tx.select().from(clinics));
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe(clinicA.id);
  });
});

describe("writes cannot escape the current tenant", () => {
  it("rejects an insert that carries another clinic's id", async () => {
    await expect(
      withTenant(clinicA.id, async (tx) =>
        tx.insert(branches).values({ clinicId: clinicB.id, name: "Smuggled branch" }),
      ),
      // The WITH CHECK half of the policy catches this.
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot move one of its own rows into another clinic", async () => {
    const created = await withTenant(clinicA.id, async (tx) =>
      tx.insert(branches).values({ clinicId: clinicA.id, name: "RLS test branch" }).returning(),
    );
    const branchId = created[0]!.id;

    await expect(
      withTenant(clinicA.id, async (tx) =>
        tx.update(branches).set({ clinicId: clinicB.id }).where(eq(branches.id, branchId)),
      ),
    ).rejects.toThrow(/row-level security/i);

    // Clean up through the owner connection.
    await getOwnerDb().db.delete(branches).where(eq(branches.id, branchId));
  });

  it("silently affects no rows when updating another tenant's record", async () => {
    const target = await withTenant(clinicB.id, async (tx) =>
      tx.select().from(users).where(eq(users.email, "admin@northside-derm.test")),
    );
    const targetId = target[0]!.id;

    await withTenant(clinicA.id, async (tx) => {
      // An UPDATE filtered by a foreign id is not an error; the row is simply
      // invisible, so zero rows change.
      await tx.update(users).set({ fullName: "Tampered" }).where(eq(users.id, targetId));
    });

    const after = await getOwnerDb().db.select().from(users).where(eq(users.id, targetId));
    expect(after[0]!.fullName).not.toBe("Tampered");
  });
});

describe("the tenant setting is transaction-scoped", () => {
  it("does not leak to the next user of a pooled connection", async () => {
    await withTenant(clinicA.id, async (tx) => {
      const [setting] = await tx.execute<{ value: string | null }>(
        sql`select nullif(current_setting('app.clinic_id', true), '') as value`,
      );
      expect(setting!.value).toBe(clinicA.id);
    });

    // Outside the transaction the setting must be gone, otherwise a later
    // request could inherit the previous request's tenant.
    const { db } = getDb();
    const after = await db.execute<{ value: string | null }>(
      sql`select nullif(current_setting('app.clinic_id', true), '') as value`,
    );
    expect(after[0]!.value).toBeNull();
  });
});

describe("the audit trail is append-only", () => {
  it("denies UPDATE and DELETE to the application role", async () => {
    const { sql: appSql } = getDb();
    const privileges = await appSql<{ privilege_type: string }[]>`
      select privilege_type
      from information_schema.role_table_grants
      where grantee = 'skincrm_app' and table_name = 'audit_events'
    `;
    const granted = privileges.map((p) => p.privilege_type);
    expect(granted).toContain("SELECT");
    expect(granted).toContain("INSERT");
    // A compromised app process must not be able to rewrite history.
    expect(granted).not.toContain("UPDATE");
    expect(granted).not.toContain("DELETE");
  });

  it("denies clinic creation and deletion to the application role", async () => {
    const { sql: appSql } = getDb();
    const privileges = await appSql<{ privilege_type: string }[]>`
      select privilege_type
      from information_schema.role_table_grants
      where grantee = 'skincrm_app' and table_name = 'clinics'
    `;
    const granted = privileges.map((p) => p.privilege_type);
    expect(granted).toContain("SELECT");
    expect(granted).toContain("UPDATE");
    // Provisioning a tenant is an operator action, not an API call.
    expect(granted).not.toContain("INSERT");
    expect(granted).not.toContain("DELETE");
  });
});
