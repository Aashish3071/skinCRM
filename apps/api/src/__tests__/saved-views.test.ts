/** Saved views and bulk assignment (PRD LEAD-01, LEAD-03). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { SEED, authenticate, createTestApp, letters, resetAuthState } from "./helpers";

const { savedViews, leads, people, leadStageEvents, activities, tasks, sourceSubmissions } = schema;
const TAG = "viewtest";
let app: FastifyInstance;
let admin: string;
let frontDesk: string;
let staff: Record<string, string>;

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  frontDesk = await authenticate(app, SEED.frontDesk);
  const users = (await app.inject({ method: "GET", url: "/users", headers: { cookie: admin } })).json().items as { id: string; email: string }[];
  staff = Object.fromEntries(users.map((u) => [u.email, u.id]));
});
afterAll(async () => {
  const { db } = getOwnerDb();
  await db.delete(savedViews).where(like(savedViews.name, `%${TAG}%`));
  const ids = (await db.select({ id: people.id }).from(people).where(like(people.displayName, `%${TAG}%`))).map((r) => r.id);
  if (ids.length) {
    const leadIds = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, ids))).map((r) => r.id);
    if (leadIds.length) await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, leadIds));
    await db.delete(activities).where(inArray(activities.personId, ids));
    await db.delete(tasks).where(inArray(tasks.personId, ids));
    await db.delete(leads).where(inArray(leads.personId, ids));
    await db.delete(sourceSubmissions).where(inArray(sourceSubmissions.personId, ids));
    await db.delete(people).where(inArray(people.id, ids));
  }
  await app.close();
  await closeAllConnections();
});

const call = (cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

describe("saved views", () => {
  it("keeps personal views private, lets admins share, and only the owner or an admin edits", async () => {
    const mine = await call(frontDesk, "POST", "/saved-views", { screen: "leads", name: `My queue ${TAG}`, query: { unassigned: "true", source: "website_form" } });
    expect(mine.statusCode).toBe(201);
    expect(mine.json()).toMatchObject({ isMine: true, shared: false });

    // Front desk can't share with the whole clinic.
    expect((await call(frontDesk, "POST", "/saved-views", { screen: "leads", name: `Shared ${TAG}`, query: {}, shared: true })).statusCode).toBe(403);

    const shared = await call(admin, "POST", "/saved-views", { screen: "leads", name: `Team view ${TAG}`, query: { view: "list" }, shared: true });
    expect(shared.statusCode).toBe(201);

    const seenByAdmin = (await call(admin, "GET", "/saved-views?screen=leads")).json().items.map((v: { name: string }) => v.name);
    expect(seenByAdmin).toContain(`Team view ${TAG}`);
    expect(seenByAdmin).not.toContain(`My queue ${TAG}`);
    const seenByDesk = (await call(frontDesk, "GET", "/saved-views?screen=leads")).json().items.map((v: { name: string }) => v.name);
    expect(seenByDesk).toEqual(expect.arrayContaining([`My queue ${TAG}`, `Team view ${TAG}`]));

    // Someone else's shared view can't be changed by front desk; a private one isn't even visible.
    expect((await call(frontDesk, "PATCH", `/saved-views/${shared.json().id}`, { name: `Renamed ${TAG}` })).statusCode).toBe(403);
    expect((await call(admin, "DELETE", `/saved-views/${mine.json().id}`)).statusCode).toBe(404);
    expect((await call(frontDesk, "PATCH", `/saved-views/${mine.json().id}`, { name: `My renamed queue ${TAG}` })).json().name).toBe(`My renamed queue ${TAG}`);
    expect((await call(frontDesk, "DELETE", `/saved-views/${mine.json().id}`)).statusCode).toBe(204);
  });

  it("refuses unknown filter keys", async () => {
    expect((await call(admin, "POST", "/saved-views", { screen: "leads", name: `Bad ${TAG}`, query: { "a-b": "x" } })).statusCode).toBe(400);
  });
});

describe("bulk assignment", () => {
  async function lead(n: number) {
    const r = await call(admin, "POST", "/leads", { source: "walk_in", person: { firstName: `Bulk${letters(n)}`, lastName: TAG, email: `bulk${n}.${TAG}@example.test`, allowDuplicate: true } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  it("assigns many at once through the normal rules, then returns them to the queue", async () => {
    const ids = [await lead(1), await lead(2), await lead(3)];
    const to = staff[SEED.frontDesk]!;
    const r = await call(admin, "POST", "/leads/bulk-assign", { leadIds: ids, ownerUserId: to });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ changed: 3, unchanged: 0, missing: 0 });
    const { db } = getOwnerDb();
    const owners = await db.select({ owner: leads.ownerUserId }).from(leads).where(inArray(leads.id, ids));
    expect(owners.every((o) => o.owner === to)).toBe(true);
    // Each lead gets its own timeline entry, as with a single reassignment.
    const timeline = await db.select().from(activities).where(eq(activities.leadId, ids[0]!));
    expect(timeline.some((a) => a.type === "assignment_change")).toBe(true);

    const again = await call(admin, "POST", "/leads/bulk-assign", { leadIds: [...ids, "00000000-0000-4000-8000-000000000000"], ownerUserId: to });
    expect(again.json()).toEqual({ changed: 0, unchanged: 3, missing: 1 });

    const back = await call(admin, "POST", "/leads/bulk-assign", { leadIds: ids, ownerUserId: null });
    expect(back.json().changed).toBe(3);
  });

  it("is admin-only and refuses an owner who isn't active staff", async () => {
    const id = await lead(4);
    expect((await call(frontDesk, "POST", "/leads/bulk-assign", { leadIds: [id], ownerUserId: null })).statusCode).toBe(403);
    expect((await call(admin, "POST", "/leads/bulk-assign", { leadIds: [id], ownerUserId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(400);
  });
});
