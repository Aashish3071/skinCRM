/**
 * Messaging core: templates, the send-safety gate and the delivery log
 * (PRD MSG-01 … MSG-07).
 *
 * Requires a migrated and seeded database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { MockEmailConnector, MockWhatsAppConnector, setConnectors, resetConnectors } from "@skincrm/connectors";
import { resetEnvCache } from "@skincrm/config";
import { SEED, authenticate, createTestApp, resetAuthState } from "./helpers";
import { inQuietHours } from "../messaging/send-gate";

const { people, messages, messageTemplates, suppressions, consentRecords, clinics, leads } = schema;

let app: FastifyInstance;
let adminCookie: string;
let email: MockEmailConnector;
let whatsapp: MockWhatsAppConnector;

const TAG = "msgtest";

beforeAll(async () => {
  app = await createTestApp();
  await resetAuthState();
  adminCookie = await authenticate(app, SEED.admin);
});

afterAll(async () => {
  await cleanup();
  await restoreClinic();
  resetConnectors();
  await app.close();
  await closeAllConnections();
});

beforeEach(async () => {
  await cleanup();
  email = new MockEmailConnector({ bounceAddresses: [`bounce.${TAG}@example.test`] });
  whatsapp = new MockWhatsAppConnector();
  setConnectors({ email, whatsapp });
  // Sending is off by default in this deployment; the gate is tested for that
  // separately, so switch it on for the rest.
  setOutboundSending(true);
  await setQuietHours("00:00", "00:00");
});

afterEach(() => {
  delete process.env.OUTBOUND_SENDING_ENABLED;
  resetEnvCache();
});

/**
 * `getEnv()` parses once and caches, so setting the variable alone does not
 * reach the send gate — the cache has to be dropped too. dotenv loads with
 * `override: false`, so an explicitly set value survives the reload.
 */
function setOutboundSending(enabled: boolean): void {
  process.env.OUTBOUND_SENDING_ENABLED = enabled ? "true" : "false";
  resetEnvCache();
}

async function cleanup(): Promise<void> {
  const { db } = getOwnerDb();
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(or(like(people.displayName, `%${TAG}%`), like(people.emailRaw, `%${TAG}%`)));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(messages).where(inArray(messages.personId, ids));
    await db.delete(suppressions).where(inArray(suppressions.personId, ids));
    await db.delete(consentRecords).where(inArray(consentRecords.personId, ids));
    await db.delete(leads).where(inArray(leads.personId, ids));
    await db.delete(people).where(inArray(people.id, ids));
  }
  await db.delete(messageTemplates).where(like(messageTemplates.key, `%${TAG}%`));
}

async function setQuietHours(start: string, end: string): Promise<void> {
  const { db } = getOwnerDb();
  await db.update(clinics).set({ quietHoursStart: start, quietHoursEnd: end });
}

async function setPromotionalApproved(approved: boolean): Promise<void> {
  const { db } = getOwnerDb();
  await db.update(clinics).set({ promotionalSendingApproved: approved });
}

async function restoreClinic(): Promise<void> {
  const { db } = getOwnerDb();
  await db
    .update(clinics)
    .set({ quietHoursStart: "21:00", quietHoursEnd: "08:00", promotionalSendingApproved: false });
}

let counter = 5000;
async function makePerson(opts: { email?: boolean } = { email: true }): Promise<string> {
  counter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/people",
    headers: { cookie: adminCookie },
    payload: {
      firstName: `Recipient${counter} ${TAG}`,
      phone: `305-555-${String(counter).padStart(4, "0")}`,
      ...(opts.email === false ? {} : { email: `p${counter}.${TAG}@example.test` }),
      allowDuplicate: true,
    },
  });
  return response.json().id as string;
}

/**
 * The clinic a person actually belongs to. Reading `clinics` with `limit(1)`
 * can return the isolation-control tenant, which silently puts fixture rows
 * where the tenant-scoped code under test will never see them.
 */
async function clinicIdForPerson(personId: string): Promise<string> {
  const { db } = getOwnerDb();
  const rows = await db
    .select({ clinicId: people.clinicId })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  return rows[0]!.clinicId;
}

async function grantConsent(personId: string, channel: string, purpose: string): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/people/${personId}/consent`,
    headers: { cookie: adminCookie },
    payload: { channel, purpose, status: "granted", source: "walk_in_form" },
  });
}

function makeTemplate(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/templates",
    headers: { cookie: adminCookie },
    payload: {
      key: `tpl_${TAG}_${++counter}`,
      name: `Template ${TAG}`,
      channel: "email",
      classification: "operational",
      subject: "Your appointment with {{clinic.name}}",
      body: "Hello {{person.firstName}}, this is a note from {{clinic.name}}.",
      ...payload,
    },
  });
}

function send(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/messages",
    headers: { cookie: adminCookie },
    payload,
  });
}

describe("templates (PRD MSG-02)", () => {
  it("creates an operational template and renders a preview", async () => {
    const created = await makeTemplate({});
    expect(created.statusCode).toBe(201);
    expect(created.json().version).toBe(1);

    const preview = await app.inject({
      method: "POST",
      url: `/templates/${created.json().id}/preview`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(preview.json().body).toContain("Sample");
    expect(preview.json().missingVariables).toEqual([]);
  });

  it("refuses a template using a variable the product does not offer", async () => {
    const response = await makeTemplate({ body: "Hi {{person.nickname}}" });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain("person.nickname");
  });

  it("refuses promotional email without an unsubscribe link", async () => {
    const response = await makeTemplate({
      classification: "promotional",
      body: "Special offer from {{clinic.name}}! {{clinic.address}}",
    });
    // CAN-SPAM: promotional email needs an unsubscribe mechanism (PRD 4.4).
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/unsubscribe/i);
  });

  it("refuses promotional email without a postal address", async () => {
    const response = await makeTemplate({
      classification: "promotional",
      body: "Special offer! {{link.unsubscribe}}",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/postal address/i);
  });

  it("accepts promotional email carrying both", async () => {
    const response = await makeTemplate({
      classification: "promotional",
      body: "Offer from {{clinic.name}}. {{clinic.address}} {{link.unsubscribe}}",
    });
    expect(response.statusCode).toBe(201);
  });

  it("bumps the version when the copy changes, so history stays explainable", async () => {
    const created = await makeTemplate({});
    const updated = await app.inject({
      method: "PATCH",
      url: `/templates/${created.json().id}`,
      headers: { cookie: adminCookie },
      payload: { body: "Hello {{person.firstName}}, updated copy." },
    });
    expect(updated.json().version).toBe(2);
  });

  it("returns a WhatsApp template to draft when its copy is edited", async () => {
    const created = await makeTemplate({
      channel: "whatsapp",
      subject: null,
      body: "Hello {{person.firstName}}",
      whatsappTemplateName: "appointment_reminder",
    });
    expect(created.json().whatsappStatus).toBe("draft");

    const { db } = getOwnerDb();
    await db
      .update(messageTemplates)
      .set({ whatsappStatus: "approved" })
      .where(eq(messageTemplates.id, created.json().id));

    const updated = await app.inject({
      method: "PATCH",
      url: `/templates/${created.json().id}`,
      headers: { cookie: adminCookie },
      payload: { body: "Hello {{person.firstName}}, changed." },
    });
    // Editing the copy invalidates Meta's approval; it must be re-approved.
    expect(updated.json().whatsappStatus).toBe("draft");
  });
});

describe("send gate: consent (PRD MSG-04)", () => {
  it("sends an operational message with no explicit consent recorded", async () => {
    const personId = await makePerson();
    const template = await makeTemplate({});
    const result = await send({ personId, templateKey: template.json().key });

    // Confirming something the client asked for has a plain legitimate basis.
    expect(result.json().state).toBe("sent");
    expect(email.outbox()).toHaveLength(1);
  });

  it("blocks a promotional message with no consent", async () => {
    await setPromotionalApproved(true);
    const personId = await makePerson();
    const template = await makeTemplate({
      classification: "promotional",
      body: "Offer from {{clinic.name}}. {{clinic.address}} {{link.unsubscribe}}",
    });

    const result = await send({ personId, templateKey: template.json().key });
    expect(result.json().state).toBe("suppressed");
    expect(result.json().suppressionReason).toBe("no_consent");
    expect(email.outbox()).toHaveLength(0);
  });

  it("sends a promotional message once consent is granted", async () => {
    await setPromotionalApproved(true);
    const personId = await makePerson();
    await grantConsent(personId, "email", "promotional");
    const template = await makeTemplate({
      classification: "promotional",
      body: "Offer from {{clinic.name}}. {{clinic.address}} {{link.unsubscribe}}",
    });

    expect((await send({ personId, templateKey: template.json().key })).json().state).toBe("sent");
  });

  it("blocks promotional sending clinic-wide until the clinic approves it", async () => {
    await setPromotionalApproved(false);
    const personId = await makePerson();
    await grantConsent(personId, "email", "promotional");
    const template = await makeTemplate({
      classification: "promotional",
      body: "Offer from {{clinic.name}}. {{clinic.address}} {{link.unsubscribe}}",
    });

    const result = await send({ personId, templateKey: template.json().key });
    // Individual consent is not enough: the clinic must sign off on copy and
    // legal basis first (PRD 4.4).
    expect(result.json().state).toBe("suppressed");
    expect(result.json().suppressionReason).toBe("no_consent");
  });

  it("blocks after a withdrawal, while leaving operational sending alone", async () => {
    await setPromotionalApproved(true);
    const personId = await makePerson();
    await grantConsent(personId, "email", "promotional");
    await grantConsent(personId, "email", "operational");

    await app.inject({
      method: "POST",
      url: `/people/${personId}/consent`,
      headers: { cookie: adminCookie },
      payload: {
        channel: "email",
        purpose: "promotional",
        status: "withdrawn",
        source: "unsubscribe_link",
      },
    });

    const promo = await makeTemplate({
      classification: "promotional",
      body: "Offer. {{clinic.address}} {{link.unsubscribe}}",
    });
    const operational = await makeTemplate({});

    expect((await send({ personId, templateKey: promo.json().key })).json().suppressionReason).toBe(
      "opted_out",
    );
    // Withdrawing marketing consent must not stop appointment messages.
    expect((await send({ personId, templateKey: operational.json().key })).json().state).toBe("sent");
  });
});

describe("send gate: suppression and safety", () => {
  it("honours the global kill switch above everything else", async () => {
    setOutboundSending(false);
    const personId = await makePerson();
    const template = await makeTemplate({});

    const result = await send({ personId, templateKey: template.json().key });
    expect(result.json().suppressionReason).toBe("global_sending_disabled");
    expect(email.outbox()).toHaveLength(0);
  });

  it("blocks a person with no address for that channel", async () => {
    const personId = await makePerson({ email: false });
    const template = await makeTemplate({});
    const result = await send({ personId, templateKey: template.json().key });
    expect(result.json().suppressionReason).toBe("missing_contact_detail");
  });

  it("blocks after an opt-out is recorded", async () => {
    const personId = await makePerson();
    const template = await makeTemplate({});

    await app.inject({
      method: "POST",
      url: "/messages/opt-out",
      headers: { cookie: adminCookie },
      payload: { personId, channel: "email", detail: "Asked to stop" },
    });

    const result = await send({ personId, templateKey: template.json().key });
    expect(result.json().suppressionReason).toBe("opted_out");
  });

  it("suppresses the address permanently after a hard bounce", async () => {
    counter += 1;
    const created = await app.inject({
      method: "POST",
      url: "/people",
      headers: { cookie: adminCookie },
      payload: {
        firstName: `Bouncer ${TAG}`,
        email: `bounce.${TAG}@example.test`,
        allowDuplicate: true,
      },
    });
    const personId = created.json().id as string;
    const template = await makeTemplate({});

    const first = await send({ personId, templateKey: template.json().key });
    expect(first.json().state).toBe("failed");

    // The provider said the address does not exist, so it must not be retried.
    const second = await send({ personId, templateKey: template.json().key });
    expect(second.json().suppressionReason).toBe("opted_out");
  });

  it("blocks inside quiet hours", async () => {
    // A window covering the whole day, so the test does not depend on the clock.
    await setQuietHours("00:00", "23:59");
    const personId = await makePerson();
    const template = await makeTemplate({});

    const result = await send({ personId, templateKey: template.json().key });
    expect(result.json().suppressionReason).toBe("quiet_hours");
  });

  it("refuses to render a message with a gap in it", async () => {
    const personId = await makePerson();
    const { db } = getOwnerDb();
    // Strip the name so {{person.firstName}} cannot resolve.
    await db.update(people).set({ firstName: null, displayName: "" }).where(eq(people.id, personId));

    const template = await makeTemplate({});
    const result = await send({ personId, templateKey: template.json().key });

    expect(result.json().state).toBe("failed");
    expect(result.json().detail).toMatch(/Missing template variables/);
    expect(email.outbox()).toHaveLength(0);
  });
});

describe("idempotency (PRD MSG-05)", () => {
  it("does not send the same logical message twice", async () => {
    const personId = await makePerson();
    const template = await makeTemplate({});

    // Same correlation id means the same idempotency key, which is what a
    // double-click or a replayed job looks like.
    const headers = { cookie: adminCookie, "x-correlation-id": `dup-${TAG}-1` };
    const payload = { personId, templateKey: template.json().key };

    const first = await app.inject({ method: "POST", url: "/messages", headers, payload });
    const second = await app.inject({ method: "POST", url: "/messages", headers, payload });

    expect(first.json().state).toBe("sent");
    expect(second.json().suppressionReason).toBe("duplicate_idempotency_key");
    expect(email.outbox()).toHaveLength(1);
  });
});

describe("WhatsApp service window (PRD WA-06)", () => {
  it("refuses a free-form message when they have never messaged us", async () => {
    const personId = await makePerson();
    const template = await makeTemplate({
      channel: "whatsapp",
      subject: null,
      body: "Hello {{person.firstName}}",
    });

    const result = await send({ personId, templateKey: template.json().key });
    expect(result.json().suppressionReason).toBe("outside_service_window");
    expect(whatsapp.outbox()).toHaveLength(0);
  });

  it("allows a free-form reply within 24 hours of their message", async () => {
    const personId = await makePerson();
    const { db } = getOwnerDb();
    const clinicId = await clinicIdForPerson(personId);

    // An inbound message an hour ago opens the window.
    await db.insert(messages).values({
      clinicId,
      personId,
      channel: "whatsapp",
      direction: "inbound",
      classification: "operational",
      state: "delivered",
      idempotencyKey: `inbound-${TAG}-${++counter}`,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const template = await makeTemplate({
      channel: "whatsapp",
      subject: null,
      body: "Hello {{person.firstName}}",
    });
    expect((await send({ personId, templateKey: template.json().key })).json().state).toBe("sent");
  });

  it("refuses a free-form reply once the window has closed", async () => {
    const personId = await makePerson();
    const { db } = getOwnerDb();
    const clinicId = await clinicIdForPerson(personId);

    await db.insert(messages).values({
      clinicId,
      personId,
      channel: "whatsapp",
      direction: "inbound",
      classification: "operational",
      state: "delivered",
      idempotencyKey: `stale-${TAG}-${++counter}`,
      createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    });

    const template = await makeTemplate({
      channel: "whatsapp",
      subject: null,
      body: "Hello {{person.firstName}}",
    });
    expect((await send({ personId, templateKey: template.json().key })).json().suppressionReason).toBe(
      "outside_service_window",
    );
  });

  it("allows an approved template outside the window, but not a paused one", async () => {
    const personId = await makePerson();
    const created = await makeTemplate({
      channel: "whatsapp",
      subject: null,
      body: "Hello {{person.firstName}}",
      whatsappTemplateName: "reminder",
    });
    const templateId = created.json().id as string;
    const { db } = getOwnerDb();

    await db.update(messageTemplates).set({ whatsappStatus: "approved" }).where(eq(messageTemplates.id, templateId));
    expect((await send({ personId, templateKey: created.json().key })).json().state).toBe("sent");

    await db.update(messageTemplates).set({ whatsappStatus: "paused" }).where(eq(messageTemplates.id, templateId));
    const paused = await app.inject({
      method: "POST",
      url: "/messages",
      headers: { cookie: adminCookie, "x-correlation-id": `paused-${TAG}` },
      payload: { personId, templateKey: created.json().key },
    });
    expect(paused.json().suppressionReason).toBe("template_not_approved");
  });
});

describe("quiet hours arithmetic", () => {
  const tz = "America/New_York";
  const at = (iso: string) => new Date(iso);

  it("handles a window that crosses midnight", () => {
    // 21:00–08:00 is the default and is the awkward case.
    expect(inQuietHours(at("2026-10-05T02:00:00Z"), tz, "21:00", "08:00")).toBe(true); // 22:00 local
    expect(inQuietHours(at("2026-10-05T10:00:00Z"), tz, "21:00", "08:00")).toBe(true); // 06:00 local
    expect(inQuietHours(at("2026-10-05T16:00:00Z"), tz, "21:00", "08:00")).toBe(false); // 12:00 local
  });

  it("handles a same-day window", () => {
    expect(inQuietHours(at("2026-10-05T17:30:00Z"), tz, "13:00", "14:00")).toBe(true); // 13:30 local
    expect(inQuietHours(at("2026-10-05T19:00:00Z"), tz, "13:00", "14:00")).toBe(false); // 15:00 local
  });

  it("treats an empty window as never quiet", () => {
    expect(inQuietHours(at("2026-10-05T02:00:00Z"), tz, "00:00", "00:00")).toBe(false);
  });
});

describe("delivery log (PRD MSG-07)", () => {
  it("records every outcome, sent and suppressed alike", async () => {
    const sentPerson = await makePerson();
    const blockedPerson = await makePerson({ email: false });
    const template = await makeTemplate({});

    await send({ personId: sentPerson, templateKey: template.json().key });
    await send({ personId: blockedPerson, templateKey: template.json().key });

    const log = await app.inject({
      method: "GET",
      url: "/messages?limit=50",
      headers: { cookie: adminCookie },
    });
    const items = log.json().items as { state: string; suppressionReason: string | null }[];

    expect(items.some((m) => m.state === "sent")).toBe(true);
    const suppressed = items.find((m) => m.state === "suppressed");
    // A blocked message is never dropped silently; the reason is always there.
    expect(suppressed).toBeDefined();
    expect(suppressed!.suppressionReason).toBe("missing_contact_detail");
  });

  it("stores the template version the message was rendered from", async () => {
    const personId = await makePerson();
    const template = await makeTemplate({});
    await send({ personId, templateKey: template.json().key });

    const log = await app.inject({
      method: "GET",
      url: `/messages?personId=${personId}`,
      headers: { cookie: adminCookie },
    });
    expect((log.json().items as { templateVersion: number }[])[0]!.templateVersion).toBe(1);
  });

  it("does not leak messages across clinics", async () => {
    const personId = await makePerson();
    const template = await makeTemplate({});
    await send({ personId, templateKey: template.json().key });

    const otherCookie = await authenticate(app, SEED.otherClinicAdmin);
    const log = await app.inject({
      method: "GET",
      url: "/messages?limit=50",
      headers: { cookie: otherCookie },
    });
    expect((log.json().items as { personId: string }[]).some((m) => m.personId === personId)).toBe(
      false,
    );
  });
});

describe("messaging permissions", () => {
  it("denies a practitioner the ability to send", async () => {
    const personId = await makePerson();
    const template = await makeTemplate({});
    const practitionerCookie = await authenticate(app, SEED.practitioner);

    const response = await app.inject({
      method: "POST",
      url: "/messages",
      headers: { cookie: practitionerCookie },
      payload: { personId, templateKey: template.json().key },
    });
    expect(response.statusCode).toBe(403);
  });

  it("denies front desk the ability to edit templates", async () => {
    const frontDeskCookie = await authenticate(app, SEED.frontDesk);
    const response = await app.inject({
      method: "POST",
      url: "/templates",
      headers: { cookie: frontDeskCookie },
      payload: {
        key: `nope_${TAG}`,
        name: "Nope",
        channel: "email",
        classification: "operational",
        body: "Hi",
      },
    });
    expect(response.statusCode).toBe(403);
  });
});
