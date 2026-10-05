/** Conversion feedback (PRD 4.5a, FB-01…10; UAT 13 and 14). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockGoogleFeedbackConnector, MockMetaCapiConnector, setFeedbackConnectors } from "@skincrm/connectors";
import { DEFAULT_FEEDBACK_MAPPING } from "@skincrm/contracts";
import { resetEnvCache } from "@skincrm/config";
import { SEED, authenticate, clinicIdBySlug, createTestApp, resetAuthState, letters } from "./helpers";
import { processFeedbackOutbox } from "../feedback/service";

const { people, leads, leadStageEvents, activities, sourceSubmissions, feedbackEvents, feedbackDestinations, notifications } = schema;
const TAG = "fbtest";
let app: FastifyInstance;
let admin: string;
let stages: Record<string, string>;
let meta: MockMetaCapiConnector;
let clinicId: string;

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  admin = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
  const r = await app.inject({ method: "GET", url: "/pipeline/stages", headers: { cookie: admin } });
  stages = Object.fromEntries((r.json().items as { id: string; category: string }[]).map((s) => [s.category, s.id]));
});
afterAll(async () => {
  await cleanup();
  setFeedbackConnectors(undefined);
  await app.close();
  await closeAllConnections();
});
beforeEach(async () => {
  await cleanup();
  meta = new MockMetaCapiConnector();
  setFeedbackConnectors({ meta, google: new MockGoogleFeedbackConnector() });
  process.env.CONVERSION_FEEDBACK_ENABLED = "true";
  resetEnvCache();
});
afterEach(() => {
  delete process.env.CONVERSION_FEEDBACK_ENABLED;
  resetEnvCache();
});

async function cleanup() {
  const { db } = getOwnerDb();
  await db.delete(feedbackDestinations).where(eq(feedbackDestinations.clinicId, clinicId ?? "00000000-0000-0000-0000-000000000000"));
  const pids = (await db.select({ id: people.id }).from(people).where(like(people.displayName, `%${TAG}%`))).map((r) => r.id);
  if (!pids.length) return;
  const lids = (await db.select({ id: leads.id }).from(leads).where(inArray(leads.personId, pids))).map((r) => r.id);
  if (lids.length) {
    await db.delete(feedbackEvents).where(inArray(feedbackEvents.leadId, lids));
    await db.delete(notifications).where(inArray(notifications.link, lids.map((l) => `/leads/${l}`)));
    await db.delete(leadStageEvents).where(inArray(leadStageEvents.leadId, lids));
    await db.update(leads).set({ sourceSubmissionId: null }).where(inArray(leads.id, lids));
    await db.delete(leads).where(inArray(leads.id, lids));
  }
  await db.delete(sourceSubmissions).where(like(sourceSubmissions.externalId, `${TAG}%`));
  await db.delete(activities).where(inArray(activities.personId, pids));
  await db.delete(people).where(inArray(people.id, pids));
}

let n = 0;
/** A lead that came from a Meta lead ad (has a Meta lead id), or a walk-in. */
async function lead(fromMeta = true, isTest = false) {
  n += 1;
  const r = await app.inject({ method: "POST", url: "/leads", headers: { cookie: admin }, payload: { person: { firstName: `F${letters(n)} ${TAG}`, email: `f${n}.${TAG}@example.test`, phone: `305-555-${6600 + n}`, allowDuplicate: true }, source: fromMeta ? "meta_lead_ad" : "walk_in" } });
  const id = r.json().id as string;
  const { db } = getOwnerDb();
  if (fromMeta) {
    const [sub] = await db.insert(sourceSubmissions).values({ clinicId, platform: "meta", source: "meta_lead_ad", externalId: `${TAG}-${n}-77001` }).returning();
    await db.update(leads).set({ sourceSubmissionId: sub!.id }).where(eq(leads.id, id));
  }
  if (isTest) await db.update(leads).set({ isTest: true }).where(eq(leads.id, id));
  return id;
}
const move = (id: string, c: string, reason?: string) => app.inject({ method: "POST", url: `/leads/${id}/stage`, headers: { cookie: admin }, payload: { stageId: stages[c], reason } });
const events = (leadId: string) => getOwnerDb().db.select().from(feedbackEvents).where(eq(feedbackEvents.leadId, leadId));

async function setUpMeta(opts: { testCode?: boolean } = { testCode: true }) {
  const mapping = { ...DEFAULT_FEEDBACK_MAPPING, qualified: { ...DEFAULT_FEEDBACK_MAPPING.qualified, enabled: true } };
  expect((await app.inject({ method: "PUT", url: "/feedback/meta/settings", headers: { cookie: admin }, payload: { mapping, includeWhatsAppAds: false } })).statusCode).toBe(200);
  expect((await app.inject({ method: "PUT", url: "/feedback/meta/credentials", headers: { cookie: admin }, payload: { datasetId: "123456789012", accessToken: "capi-secret-token", testEventCode: opts.testCode ? "TEST123" : "" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/feedback/meta/checklist", headers: { cookie: admin }, payload: { privacyApproved: true, policyChecked: true, dataUnderstood: true } })).statusCode).toBe(200);
}

describe("off by default (FB-03)", () => {
  it("queues nothing for an unreviewed destination", async () => {
    const mapping = { ...DEFAULT_FEEDBACK_MAPPING, qualified: { ...DEFAULT_FEEDBACK_MAPPING.qualified, enabled: true } };
    await app.inject({ method: "PUT", url: "/feedback/meta/settings", headers: { cookie: admin }, payload: { mapping, includeWhatsAppAds: false } });
    const id = await lead();
    await move(id, "consultation_booked");
    expect(await events(id)).toHaveLength(0);
  });

  it("refuses an event name that discloses a service (UAT 14)", async () => {
    const mapping = { ...DEFAULT_FEEDBACK_MAPPING, qualified: { enabled: true, eventName: "Botox consult", conversionActionId: "" } };
    const r = await app.inject({ method: "PUT", url: "/feedback/meta/settings", headers: { cookie: admin }, payload: { mapping, includeWhatsAppAds: false } });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/botox/i);
  });

  it("won't go live before a successful test", async () => {
    await setUpMeta();
    const r = await app.inject({ method: "POST", url: "/feedback/meta/go-live", headers: { cookie: admin }, payload: { confirm: true } });
    expect(r.statusCode).toBe(400);
  });
});

describe("the outbox (FB-05, UAT 13)", () => {
  it("one event per milestone, however many times it's reached or replayed", async () => {
    await setUpMeta();
    const id = await lead();
    await move(id, "consultation_booked");
    await move(id, "lost", "Changed mind");
    await move(id, "consultation_booked");
    await processFeedbackOutbox();
    await processFeedbackOutbox();
    const rows = (await events(id)).filter((e) => e.milestone === "qualified");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("accepted");
    expect(rows[0]!.testMode).toBe(true);
    expect(meta.sent).toHaveLength(1);
  });

  it("keeps queued test outcomes in test mode after production is enabled", async () => {
    await setUpMeta();
    const id = await lead();
    await move(id, "consultation_booked");
    const test = await app.inject({ method: "POST", url: "/feedback/meta/test", headers: { cookie: admin } });
    expect(test.json().ok).toBe(true);
    const live = await app.inject({ method: "POST", url: "/feedback/meta/go-live", headers: { cookie: admin }, payload: { confirm: true } });
    expect(live.statusCode).toBe(200);
    await processFeedbackOutbox();
    expect((await events(id))[0]!.testMode).toBe(true);
    expect((meta.sent.at(-1)!.payload as { test_event_code?: string }).test_event_code).toBe("TEST123");
  });

  it("sends only the allowlisted fields — no names, contact details or services", async () => {
    await setUpMeta();
    const id = await lead();
    await move(id, "consultation_booked");
    await processFeedbackOutbox();
    const body = JSON.stringify(meta.sent[0]!.payload);
    expect(body).toContain(`${TAG}-`); // the Meta lead id
    expect(body).not.toMatch(new RegExp(`F\\d+|${TAG}@|305-555|example\\.test`));
    const event = (meta.sent[0]!.payload as { data: Record<string, unknown>[] }).data[0]!;
    expect(Object.keys(event).sort()).toEqual(["action_source", "custom_data", "event_id", "event_name", "event_time", "user_data"]);
    expect(Object.keys(event.user_data as object)).toEqual(["lead_id"]);
    expect((meta.sent[0]!.payload as { test_event_code?: string }).test_event_code).toBe("TEST123");
  });

  it("records a lead that didn't come from the ad as unmatched, and never sends it", async () => {
    await setUpMeta();
    const id = await lead(false);
    await move(id, "consultation_booked");
    await processFeedbackOutbox();
    const rows = await events(id);
    expect(rows[0]!.state).toBe("unmatched");
    expect(meta.sent).toHaveLength(0);
  });

  it("never sends a test lead", async () => {
    await setUpMeta();
    const id = await lead(true, true);
    await move(id, "consultation_booked");
    await processFeedbackOutbox();
    expect((await events(id))[0]!.state).toBe("blocked");
    expect(meta.sent).toHaveLength(0);
  });
});

describe("kill switches (FB-07)", () => {
  it("the installation switch blocks sending", async () => {
    await setUpMeta();
    process.env.CONVERSION_FEEDBACK_ENABLED = "false";
    resetEnvCache();
    const id = await lead();
    await move(id, "consultation_booked");
    await processFeedbackOutbox();
    expect((await events(id))[0]!.state).toBe("blocked");
    expect(meta.sent).toHaveLength(0);
  });

  it("pausing cancels what's waiting", async () => {
    await setUpMeta();
    const id = await lead();
    await move(id, "consultation_booked");
    await app.inject({ method: "POST", url: "/feedback/meta/pause", headers: { cookie: admin }, payload: { paused: true } });
    await processFeedbackOutbox();
    expect((await events(id))[0]!.state).toBe("canceled");
    expect(meta.sent).toHaveLength(0);
  });

  it("revoking credentials cancels and resets to unreviewed", async () => {
    await setUpMeta();
    const r = await app.inject({ method: "DELETE", url: "/feedback/meta/credentials", headers: { cookie: admin } });
    expect(r.json().eligibility).toBe("unreviewed");
    expect(r.json().connected).toBe(false);
  });
});

describe("test and preview (FB-04)", () => {
  it("a test event succeeds in test mode, then go-live is allowed", async () => {
    await setUpMeta();
    const t = await app.inject({ method: "POST", url: "/feedback/meta/test", headers: { cookie: admin } });
    expect(t.json().ok).toBe(true);
    expect((meta.sent[0]!.payload as { test_event_code?: string }).test_event_code).toBe("TEST123");
    const live = await app.inject({ method: "POST", url: "/feedback/meta/go-live", headers: { cookie: admin }, payload: { confirm: true } });
    expect(live.json().eligibility).toBe("approved_production");
  });

  it("the preview masks identifiers and never returns the token", async () => {
    await setUpMeta();
    await lead();
    const p = await app.inject({ method: "POST", url: "/feedback/meta/preview", headers: { cookie: admin }, payload: {} });
    expect(p.statusCode).toBe(200);
    expect(p.body).not.toContain("capi-secret-token");
    expect(JSON.stringify(p.json().identifiers)).toContain("•");
    const overview = await app.inject({ method: "GET", url: "/feedback", headers: { cookie: admin } });
    expect(overview.body).not.toContain("capi-secret-token");
  });

  it("is closed to front desk staff", async () => {
    const fd = await authenticate(app, SEED.frontDesk);
    expect((await app.inject({ method: "GET", url: "/feedback", headers: { cookie: fd } })).statusCode).toBe(403);
  });
});
