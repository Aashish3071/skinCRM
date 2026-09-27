import { sql } from "drizzle-orm";
import { withoutTenantScope } from "@skincrm/db";
import { pruneExpiredSessions } from "../auth/sessions";
import { runEnrollment } from "../automations/engine";
import { runAsSystem } from "../automations/system-context";
import { logger } from "../logger";
import { applyRetention } from "../ops/monitor";

/** How long a claimed run is reserved for one worker before another may retry it. */
const CLAIM_SECONDS = 120;
/** A run that throws this many times in a row is marked failed. */
const MAX_RUN_ERRORS = 5;

/**
 * Claim due automation runs and advance each one.
 *
 * The claim is a single UPDATE … FOR UPDATE SKIP LOCKED, so any number of
 * worker processes can run this concurrently without two of them taking the
 * same run. It needs the owner connection because it looks across clinics;
 * it returns only ids, and each run is then executed inside its own clinic's
 * tenant transaction with row-level security back in force.
 */
export async function processDueAutomations(limit = 25, now = new Date()): Promise<number> {
  const claimed = await withoutTenantScope("worker: claim due automation runs across clinics", async (db) => {
    const result = await db.execute<{ id: string; clinic_id: string }>(sql`
      update automation_enrollments
      set locked_until = ${now.toISOString()}::timestamptz + make_interval(secs => ${CLAIM_SECONDS})
      where id in (
        select id from automation_enrollments
        where state = 'active'
          and next_run_at <= ${now.toISOString()}::timestamptz
          and (locked_until is null or locked_until < ${now.toISOString()}::timestamptz)
        order by next_run_at
        limit ${limit}
        for update skip locked
      )
      returning id, clinic_id
    `);
    return [...result];
  });

  for (const row of claimed) {
    try {
      await runAsSystem(row.clinic_id, () => runEnrollment(row.id, now), {
        correlationId: `automation-${row.id}`,
      });
    } catch (error) {
      await recordRunError(row.id, row.clinic_id, error, now);
    }
  }
  return claimed.length;
}

/**
 * The run's own transaction rolled back, so the failure is recorded in a new
 * one. Backs off, and gives up after MAX_RUN_ERRORS so one broken run cannot
 * spin forever.
 */
async function recordRunError(id: string, clinicId: string, error: unknown, now: Date): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ enrollmentId: id, err: message }, "Automation run failed");
  await withoutTenantScope("worker: record automation run failure", async (db) => {
    await db.execute(sql`
      update automation_enrollments
      set attempts = attempts + 1,
          last_error = ${message.slice(0, 500)},
          locked_until = null,
          next_run_at = ${now.toISOString()}::timestamptz + make_interval(mins => 5 * (attempts + 1)),
          state = case when attempts + 1 >= ${MAX_RUN_ERRORS} then 'failed'::enrollment_state else state end,
          finished_at = case when attempts + 1 >= ${MAX_RUN_ERRORS} then ${now.toISOString()}::timestamptz else finished_at end,
          stop_reason = case when attempts + 1 >= ${MAX_RUN_ERRORS} then 'Gave up after repeated errors' else stop_reason end,
          updated_at = now()
      where id = ${id} and clinic_id = ${clinicId}
    `);
  });
}

export async function housekeeping(): Promise<void> {
  const pruned = await pruneExpiredSessions();
  if (pruned > 0) logger.info({ pruned }, "Pruned expired sessions");
  const retained = await applyRetention();
  if (retained.rawPayloads || retained.inboundEvents) logger.info(retained, "Applied data retention");
}
