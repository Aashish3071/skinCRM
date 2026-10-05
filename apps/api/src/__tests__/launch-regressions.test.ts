import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { schema, getOwnerDb, closeAllConnections } from "@skincrm/db";
import { resetEnvCache } from "@skincrm/config";
import {
  createTestApp,
  authenticate,
  resetAuthState,
  SEED,
  clinicIdBySlug,
} from "./helpers";
import { runAsSystem } from "../automations/system-context";
import { deliverOnce } from "../messaging/delivery";
let app: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let clinicId: string;
const ids: string[] = [];
const receiptKeys: string[] = [];
const oldMode = process.env.CONNECTOR_WHATSAPP;
beforeAll(async () => {
  process.env.CONNECTOR_WHATSAPP = "mock";
  resetEnvCache();
  app = await createTestApp();
  await resetAuthState();
  cookie = await authenticate(app, SEED.admin);
  clinicId = await clinicIdBySlug(SEED.clinicA);
});
afterAll(async () => {
  const db = getOwnerDb().db;
  if (receiptKeys.length)
    await db
      .delete(schema.deliveryAttempts)
      .where(inArray(schema.deliveryAttempts.idempotencyKey, receiptKeys));
  if (ids.length) {
    await db
      .delete(schema.personMerges)
      .where(inArray(schema.personMerges.mergedPersonId, ids));
    await db.delete(schema.people).where(inArray(schema.people.id, ids));
  }
  if (oldMode === undefined) delete process.env.CONNECTOR_WHATSAPP;
  else process.env.CONNECTOR_WHATSAPP = oldMode;
  resetEnvCache();
  await app.close();
  await closeAllConnections();
});
async function person() {
  const [p] = await getOwnerDb()
    .db.insert(schema.people)
    .values({
      clinicId,
      displayName: "Launch regression",
      emailRaw: `${randomUUID()}@example.test`,
    })
    .returning();
  ids.push(p!.id);
  return p!;
}
const call = (
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
) => app.inject({ method, url, payload, headers: { cookie } });
it("rejects simulation in live mode even though the shared connector is mock", async () => {
  process.env.CONNECTOR_WHATSAPP = "live";
  resetEnvCache();
  try {
    expect(
      (
        await call("POST", "/inbox/simulate", {
          phone: "+12025550167",
          body: "Should never be created",
        })
      ).statusCode,
    ).toBe(403);
    expect((await call("GET", "/conversations")).json().simulateAvailable).toBe(
      false,
    );
  } finally {
    process.env.CONNECTOR_WHATSAPP = "mock";
    resetEnvCache();
  }
});
it("pages an entire long conversation without losing tied timestamps", async () => {
  const p = await person();
  const db = getOwnerDb().db;
  const [c] = await db
    .insert(schema.conversations)
    .values({ clinicId, personId: p.id })
    .returning();
  const at = new Date();
  await db
    .insert(schema.messages)
    .values(
      Array.from({ length: 507 }, (_, i) => ({
        clinicId,
        personId: p.id,
        conversationId: c!.id,
        channel: "whatsapp" as const,
        classification: "operational" as const,
        renderedBody: `Message ${i}`,
        idempotencyKey: randomUUID(),
        createdAt: at,
      })),
    );
  const expected = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, c!.id));
  const seen: string[] = [];
  let query = "";
  do {
    const r = await call("GET", `/conversations/${c!.id}${query}`);
    expect(r.statusCode).toBe(200);
    const page = r.json();
    seen.push(...page.items.map((m: { id: string }) => m.id));
    query = page.nextCursor ? `?${new URLSearchParams(page.nextCursor)}` : "";
  } while (query);
  expect(seen.length).toBe(507);
  expect(new Set(seen)).toEqual(new Set(expected.map((r) => r.id)));
});
it("merges two existing threads and appointments, and restores them on undo", async () => {
  const a = await person(),
    b = await person();
  const db = getOwnerDb().db;
  const [ca, cb] = await db
    .insert(schema.conversations)
    .values([
      { clinicId, personId: a.id },
      { clinicId, personId: b.id },
    ])
    .returning();
  const [message] = await db
    .insert(schema.messages)
    .values({
      clinicId,
      personId: b.id,
      conversationId: cb!.id,
      channel: "whatsapp",
      classification: "operational",
      idempotencyKey: randomUUID(),
      renderedBody: "Original history",
    })
    .returning();
  const [staff] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, SEED.admin));
  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      clinicId,
      personId: b.id,
      staffUserId: staff!.id,
      startsAt: new Date("2036-01-01T08:00:00Z"),
      endsAt: new Date("2036-01-01T08:30:00Z"),
      status: "canceled",
    })
    .returning();
  expect(
    (await call("POST", `/people/${a.id}/merge`, { mergedPersonId: b.id }))
      .statusCode,
  ).toBe(200);
  const [moved] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, message!.id));
  expect(moved).toMatchObject({ personId: a.id, conversationId: ca!.id });
  expect(
    (
      await db
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, appointment!.id))
    )[0]!.personId,
  ).toBe(a.id);
  const [merge] = await db
    .select()
    .from(schema.personMerges)
    .where(eq(schema.personMerges.mergedPersonId, b.id));
  const undo = await call("POST", `/people/merges/${merge!.id}/revert`);
  expect(undo.statusCode, undo.body).toBe(204);
  expect(
    (
      await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, message!.id))
    )[0],
  ).toMatchObject({ personId: b.id, conversationId: cb!.id });
  expect(
    (
      await db
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, appointment!.id))
    )[0]!.personId,
  ).toBe(b.id);
});
it("keeps a provider receipt after transaction rollback and never sends it twice", async () => {
  const p = await person();
  const key = randomUUID();
  receiptKeys.push(key);
  let sends = 0;
  const input = {
    key,
    personId: p.id,
    channel: "email",
    payload: { body: "Hello" },
  };
  const send = async () => {
    sends++;
    return { providerMessageId: "receipt", acceptedAt: new Date() };
  };
  await expect(
    runAsSystem(clinicId, async () => {
      await deliverOnce(input, send);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  const receipt = await runAsSystem(clinicId, () => deliverOnce(input, send));
  expect(receipt.providerMessageId).toBe("receipt");
  expect(sends).toBe(1);
});
it("blocks retry when a provider may have accepted a timed-out request", async () => {
  const p = await person();
  const key = randomUUID();
  receiptKeys.push(key);
  let sends = 0;
  const input = {
    key,
    personId: p.id,
    channel: "whatsapp",
    payload: { body: "Hello" },
  };
  const send = async () => {
    sends++;
    throw new Error("timeout after acceptance");
  };
  for (let i = 0; i < 2; i++)
    await expect(
      runAsSystem(clinicId, () => deliverOnce(input, send)),
    ).rejects.toMatchObject({
      options: { retryable: false, providerCode: "delivery_uncertain" },
    });
  expect(sends).toBe(1);
});
it("rejects reusing a delivery key for different content", async () => {
  const p = await person();
  const key = randomUUID();
  receiptKeys.push(key);
  const input = { key, personId: p.id, channel: "email", payload: "First" };
  const send = async () => ({
    providerMessageId: "same-key",
    acceptedAt: new Date(),
  });
  await runAsSystem(clinicId, () => deliverOnce(input, send));
  await expect(
    runAsSystem(clinicId, () =>
      deliverOnce({ ...input, payload: "Different" }, send),
    ),
  ).rejects.toThrow("different content");
});
it("imports mapped WhatsApp templates and invalidates approval after a content edit", async () => {
  const db = getOwnerDb().db;
  const prior = (
    await db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.clinicId, clinicId))
  ).find((c) => c.provider === "whatsapp_cloud");
  let connectionId: string | undefined;
  if (!prior) {
    const [c] = await db
      .insert(schema.integrationConnections)
      .values({
        clinicId,
        provider: "whatsapp_cloud",
        externalAccountId: "mock",
        displayName: "Test WhatsApp",
      })
      .returning();
    connectionId = c!.id;
  }
  try {
    const result = await call("POST", "/templates/whatsapp/import", {
      id: "mock_greeting",
      variables: ["person.firstName"],
    });
    expect(result.statusCode, result.body).toBe(200);
    const [template] = await db
      .select()
      .from(schema.messageTemplates)
      .where(eq(schema.messageTemplates.key, "wa_mock_greeting_en"));
    expect(template!.whatsappStatus).toBe("approved");
    await db
      .update(schema.messageTemplates)
      .set({ body: "Different message" })
      .where(eq(schema.messageTemplates.id, template!.id));
    expect((await call("POST", "/templates/whatsapp/sync")).statusCode).toBe(
      200,
    );
    expect(
      (
        await db
          .select()
          .from(schema.messageTemplates)
          .where(eq(schema.messageTemplates.id, template!.id))
      )[0]!.whatsappStatus,
    ).toBe("draft");
  } finally {
    await db
      .delete(schema.messageTemplates)
      .where(eq(schema.messageTemplates.key, "wa_mock_greeting_en"));
    if (connectionId)
      await db
        .delete(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, connectionId));
  }
});
it("limits settings changes to admins and preserves pipeline stage identities", async () => {
  const frontDesk = await authenticate(app, SEED.frontDesk);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/settings/branches",
        headers: { cookie: frontDesk },
        payload: { name: "Not allowed" },
      })
    ).statusCode,
  ).toBe(403);
  const create = await call("POST", "/settings/branches", {
    name: `QA ${randomUUID()}`,
    city: "Test City",
  });
  expect(create.statusCode).toBe(200);
  const id = create.json().id;
  try {
    const archive = await app.inject({
      method: "DELETE",
      url: `/settings/branches/${id}`,
      headers: { cookie },
    });
    expect(archive.statusCode).toBe(200);
    const listed = (await call("GET", "/settings/branches")).json();
    expect(listed.items.some((b: { id: string }) => b.id === id)).toBe(false);
  } finally {
    await getOwnerDb()
      .db.delete(schema.branches)
      .where(eq(schema.branches.id, id));
  }
  const stages = (await call("GET", "/pipeline/stages")).json().items;
  const invalid = await app.inject({
    method: "PUT",
    url: "/settings/pipeline",
    headers: { cookie },
    payload: { stages: [stages[0], stages[0]] },
  });
  expect(invalid.statusCode).toBe(400);
});
it("undo keeps messages created after a merge with the survivor", async () => {
  const a = await person(),
    b = await person(),
    db = getOwnerDb().db;
  const [c] = await db
    .insert(schema.conversations)
    .values({ clinicId, personId: b.id })
    .returning();
  const [old] = await db
    .insert(schema.messages)
    .values({
      clinicId,
      personId: b.id,
      conversationId: c!.id,
      channel: "whatsapp",
      classification: "operational",
      idempotencyKey: randomUUID(),
    })
    .returning();
  expect(
    (await call("POST", `/people/${a.id}/merge`, { mergedPersonId: b.id }))
      .statusCode,
  ).toBe(200);
  const [recent] = await db
    .insert(schema.messages)
    .values({
      clinicId,
      personId: a.id,
      conversationId: c!.id,
      channel: "whatsapp",
      classification: "operational",
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [merge] = await db
    .select()
    .from(schema.personMerges)
    .where(eq(schema.personMerges.mergedPersonId, b.id));
  expect(
    (await call("POST", `/people/merges/${merge!.id}/revert`)).statusCode,
  ).toBe(204);
  const [restored] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, old!.id));
  const [kept] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, recent!.id));
  expect(restored).toMatchObject({ personId: b.id, conversationId: c!.id });
  expect(kept!.personId).toBe(a.id);
  expect(kept!.conversationId).not.toBe(c!.id);
});
it("edits and archives inquiry notes with audit records, and saves searchable inbox tags", async () => {
  const p = await person(),
    db = getOwnerDb().db;
  const [stage] = await db
    .select()
    .from(schema.pipelineStages)
    .where(eq(schema.pipelineStages.clinicId, clinicId));
  const [lead] = await db
    .insert(schema.leads)
    .values({ clinicId, personId: p.id, stageId: stage!.id, source: "walk_in" })
    .returning();
  const [note] = await db
    .insert(schema.activities)
    .values({
      clinicId,
      personId: p.id,
      leadId: lead!.id,
      type: "note",
      summary: "Inquiry note",
      body: "Original",
    })
    .returning();
  const url = `/leads/${lead!.id}/notes/${note!.id}`;
  expect(
    (
      await app.inject({
        method: "PATCH",
        url,
        headers: { cookie },
        payload: { body: "Edited" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await call("GET", `/leads/${lead!.id}/timeline`)).json().items[0].body,
  ).toBe("Edited");
  expect(
    (await app.inject({ method: "DELETE", url, headers: { cookie } }))
      .statusCode,
  ).toBe(200);
  expect(
    (await call("GET", `/leads/${lead!.id}/timeline`)).json().items,
  ).toHaveLength(0);
  const audits = await db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityId, note!.id));
  expect(audits).toHaveLength(2);
  const [c] = await db
    .insert(schema.conversations)
    .values({ clinicId, personId: p.id, lastMessageAt: new Date() })
    .returning();
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/conversations/${c!.id}/tags`,
        headers: { cookie },
        payload: { tags: ["Follow Up", "follow up"] },
      })
    ).statusCode,
  ).toBe(200);
  const matches = (
    await call("GET", "/conversations?search=follow%20up")
  ).json().items;
  expect(matches.find((row: { id: string }) => row.id === c!.id).tags).toEqual([
    "follow up",
  ]);
});
it("restores a delivery log from the encrypted receipt without resending", async () => {
  const p = await person();
  const key = randomUUID();
  receiptKeys.push(key);
  const { restoreReceipt } = await import("../messaging/delivery");
  await runAsSystem(clinicId, () =>
    deliverOnce(
      {
        key,
        personId: p.id,
        channel: "email",
        payload: {
          destination: p.emailRaw,
          body: "Recovered content",
          classification: "operational",
        },
      },
      async () => ({
        providerMessageId: "recovered-provider-id",
        acceptedAt: new Date(),
      }),
    ),
  );
  const [receipt] = await getOwnerDb()
    .db.select()
    .from(schema.deliveryAttempts)
    .where(eq(schema.deliveryAttempts.idempotencyKey, key));
  expect(receipt!.payloadEncrypted).not.toContain("Recovered content");
  await runAsSystem(clinicId, () => restoreReceipt(receipt!));
  await runAsSystem(clinicId, () => restoreReceipt(receipt!));
  const rows = await getOwnerDb()
    .db.select()
    .from(schema.messages)
    .where(eq(schema.messages.idempotencyKey, key));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    renderedBody: "Recovered content",
    state: "sent",
    providerMessageId: "recovered-provider-id",
  });
});
it("honours a WhatsApp STOP without opening another sales inquiry", async () => {
  const p = await person(),
    db = getOwnerDb().db;
  await db
    .update(schema.people)
    .set({
      phoneRaw: "+12025550277",
      phoneE164: "+12025550277",
      phoneValid: true,
    })
    .where(eq(schema.people.id, p.id));
  const { receiveInboundWhatsApp } = await import("../inbox/service");
  await runAsSystem(clinicId, () =>
    receiveInboundWhatsApp({
      waId: "12025550277",
      body: "STOP",
      providerMessageId: randomUUID(),
    }),
  );
  expect(
    await db.select().from(schema.leads).where(eq(schema.leads.personId, p.id)),
  ).toHaveLength(0);
  expect(
    (
      await db
        .select()
        .from(schema.suppressions)
        .where(eq(schema.suppressions.personId, p.id))
    )[0]!.destination,
  ).toBe("12025550277");
  expect(
    (
      await db
        .select()
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.personId, p.id))
    ).map((c) => c.status),
  ).toEqual(["withdrawn", "withdrawn"]);
});
