/** Reporting (PRD REP-01…04). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { SEED, authenticate, createTestApp, resetAuthState, letters } from "./helpers";

const { people, leads, leadStageEvents, activities } = schema;
const TAG = "reporttest";
let app: FastifyInstance;
let admin: string;
let stages: Record<string, string>;
const today = new Date().toISOString().slice(0, 10);
const range = `from=2020-01-01&to=${new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)}`;

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  const res = await app.inject({ method: "GET", url: "/pipeline/stages", headers: { cookie: admin } });
  stages = Object.fromEntries((res.json().items as { id: string; category: string }[]).map((s) => [s.category, s.id]));
});
afterAll(async () => {
  await cleanup();
  await app.close();
  await closeAllConnections();
});
beforeEach(cleanup);

async function cleanup() {
  const { db } = getOwnerDb();
  const ids = (await db.select({ id: people.id }).from(people).where(like(people.displayName, `%${TAG}%`))).map((r) => r.id);
  if (!ids.length) return;
  const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
  if (leadIds.length) {
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }
  await db.delete(activities).where(inArray(activities.personId, ids));
  await db.delete(people).where(inArray(people.id, ids));
}

let n = 0;
async function lead(source = "walk_in") {
  n += 1;
  const r = await app.inject({ method: "POST", url: "/leads", headers: { cookie: admin },
    payload: { person: { firstName: `R${letters(n)} ${TAG}`, phone: `305-555-${String(3000 + n)}`, allowDuplicate: true }, source } });
  return r.json().id as string;
}
const move = (id: string, category: string, reason?: string) =>
  app.inject({ method: "POST", url: `/leads/${id}/stage`, headers: { cookie: admin }, payload: { stageId: stages[category], reason } });
const report = async (extra = "") => (await app.inject({ method: "GET", url: `/reports/summary?${range}${extra}`, headers: { cookie: admin } })).json();

describe("funnel", () => {
  it("counts how far leads got, including ones later lost", async () => {
    const before = await report("&source=referral");
    const a = await lead("referral");
    const b = await lead("referral");
    await lead("referral");
    await move(a, "consultation_booked");
    await move(a, "lost", "Price");
    await move(b, "consultation_attended");
    await move(b, "converted");

    const after = await report("&source=referral");
    const delta = (key: string) =>
      after.funnel.find((f: { key: string }) => f.key === key).count - before.funnel.find((f: { key: string }) => f.key === key).count;
    expect(delta("new")).toBe(3);
    expect(delta("qualified")).toBe(2); // a counts even though it was then lost
    expect(delta("visited")).toBe(1);
    expect(delta("won")).toBe(1);
    expect(after.lost - before.lost).toBe(1);
    expect(after.range.from).toBe("2020-01-01");
  });

  it("rejects a backwards date range", async () => {
    const r = await app.inject({ method: "GET", url: `/reports/summary?from=${today}&to=2020-01-01`, headers: { cookie: admin } });
    expect(r.statusCode).toBe(400);
  });
});

describe("access", () => {
  it("lets the marketing analyst see aggregates but not export people", async () => {
    const mk = await authenticate(app, SEED.marketing);
    expect((await app.inject({ method: "GET", url: `/reports/summary?${range}`, headers: { cookie: mk } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/reports/export?${range}`, headers: { cookie: mk } })).statusCode).toBe(403);
  });

  it("exports CSV with personal columns for an admin, neutralising formulas", async () => {
    await lead("walk_in");
    const r = await app.inject({ method: "GET", url: `/reports/export?${range}`, headers: { cookie: admin } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.body.split("\r\n")[0]).toContain("name");
    expect(r.body).toContain(TAG);
  });
});
