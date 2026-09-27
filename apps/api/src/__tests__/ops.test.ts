/** Phase 9: monitoring, retention, health endpoints and the audit log. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { resetEnvCache } from "@skincrm/config";
import { SEED, authenticate, clinicIdBySlug, createTestApp, resetAuthState } from "./helpers";
import { applyRetention, collectAlerts, heartbeat } from "../ops/monitor";

const { rawPayloads, opsHeartbeats } = schema;
let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  process.env.MONITOR_TOKEN = "test-monitor-token-123456";
  resetEnvCache();
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
});
afterAll(async () => {
  delete process.env.MONITOR_TOKEN;
  resetEnvCache();
  await getOwnerDb().db.delete(opsHeartbeats).where(like(opsHeartbeats.key, "test%"));
  await app.close();
  await closeAllConnections();
});

describe("monitoring", () => {
  it("flags a worker that has stopped reporting, and clears once it beats", async () => {
    const future = new Date(Date.now() + 10 * 60_000);
    expect((await collectAlerts(future)).some((a) => a.key === "worker_down")).toBe(true);
    await heartbeat("worker");
    expect((await collectAlerts()).some((a) => a.key === "worker_down")).toBe(false);
  });

  it("hides /health/alerts without the token, and reports with it", async () => {
    expect((await app.inject({ method: "GET", url: "/health/alerts" })).statusCode).toBe(404);
    const ok = await app.inject({ method: "GET", url: "/health/alerts", headers: { "x-monitor-token": "test-monitor-token-123456" } });
    expect([200, 503]).toContain(ok.statusCode);
    expect(Array.isArray(ok.json().alerts)).toBe(true);
  });

  it("the application role cannot read ops heartbeats", async () => {
    const { getDb } = await import("@skincrm/db");
    await expect(getDb().sql`select * from ops_heartbeats`).rejects.toThrow(/permission denied/);
  });
});

describe("retention", () => {
  it("deletes raw payloads past their retention date and keeps recent ones", async () => {
    const clinicId = await clinicIdBySlug(SEED.clinicA);
    const { db } = getOwnerDb();
    const [old] = await db.insert(rawPayloads).values({ clinicId, platform: "internal", encryptedPayload: "x", fingerprint: "test-old", receivedAt: new Date(Date.now() - 400 * 86_400_000) }).returning();
    const [fresh] = await db.insert(rawPayloads).values({ clinicId, platform: "internal", encryptedPayload: "x", fingerprint: "test-new" }).returning();
    await applyRetention();
    expect(await db.select().from(rawPayloads).where(eq(rawPayloads.id, old!.id))).toHaveLength(0);
    expect(await db.select().from(rawPayloads).where(eq(rawPayloads.id, fresh!.id))).toHaveLength(1);
    await db.delete(rawPayloads).where(eq(rawPayloads.id, fresh!.id));
  });
});

describe("audit log", () => {
  it("shows admins the trail, including their own sign-in", async () => {
    const r = await app.inject({ method: "GET", url: "/audit-events?action=login_success&limit=5", headers: { cookie: admin } });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.length).toBeGreaterThan(0);
    expect(r.json().items[0].action).toBe("login_success");
  });

  it("is closed to front desk staff", async () => {
    const fd = await authenticate(app, SEED.frontDesk);
    expect((await app.inject({ method: "GET", url: "/audit-events", headers: { cookie: fd } })).statusCode).toBe(403);
  });

  it("cannot be rewritten by the application role", async () => {
    const { getDb } = await import("@skincrm/db");
    await expect(getDb().sql`delete from audit_events`).rejects.toThrow(/permission denied/);

  });
});
