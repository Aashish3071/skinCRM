/** An ops alert email that fails must not silence the alert for the next hour. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeAllConnections, getOwnerDb, schema } from "@skincrm/db";
import { resetEnvCache } from "@skincrm/config";

const sendSystemEmail = vi.fn<(params: { to: string; subject: string; text: string }) => Promise<boolean>>();
vi.mock("../messaging/system-email", () => ({ sendSystemEmail, webLink: (path: string) => path }));

const { runMonitor, lastBeat } = await import("../ops/monitor");
const { opsHeartbeats } = schema;
const KEY = "alert:worker_down";

beforeAll(async () => {
  process.env.OPS_ALERT_EMAIL = "ops@example.test";
  resetEnvCache();
  await getOwnerDb().db.delete(opsHeartbeats).where(eq(opsHeartbeats.key, KEY));
});
afterAll(async () => {
  delete process.env.OPS_ALERT_EMAIL;
  resetEnvCache();
  await getOwnerDb().db.delete(opsHeartbeats).where(eq(opsHeartbeats.key, KEY));
  await closeAllConnections();
});

describe("ops alert emails", () => {
  // Far enough ahead that the worker heartbeat is always stale.
  const later = new Date(Date.now() + 10 * 60_000);

  it("retries on the next run when the email fails, and goes quiet once one is delivered", async () => {
    sendSystemEmail.mockResolvedValue(false);
    await runMonitor(later);
    expect(sendSystemEmail).toHaveBeenCalled();
    expect(await lastBeat(KEY)).toBeNull();

    sendSystemEmail.mockClear();
    sendSystemEmail.mockResolvedValue(true);
    await runMonitor(later);
    expect(sendSystemEmail).toHaveBeenCalled();
    expect(await lastBeat(KEY)).not.toBeNull();

    sendSystemEmail.mockClear();
    await runMonitor(later);
    expect(sendSystemEmail.mock.calls.some(([params]) => params.subject.includes("worker"))).toBe(false);
  });
});
