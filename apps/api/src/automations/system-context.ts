import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, withTenant } from "@skincrm/db";
import { createContext, runWithContext } from "../context";

/**
 * Run `fn` as the system, inside one clinic's tenant transaction.
 *
 * Background work (automation runs, scheduled jobs) has no request, but the
 * services it calls read the tenant transaction and clinic from the request
 * context. This builds that context with no user: activities read "system",
 * audit rows carry no actor, and row-level security confines every query to
 * the one clinic exactly as it does for a request.
 *
 * It grants no capabilities. Background code calls services directly; it
 * never passes through a route's capability check, so there is nothing to
 * grant, and an empty set means a mistaken capability check fails closed.
 */
export async function runAsSystem<T>(
  clinicId: string,
  fn: () => Promise<T>,
  options: { correlationId?: string } = {},
): Promise<T> {
  return withTenant(clinicId, async (tx) => {
    const clinic = await tx
      .select({ timezone: schema.clinics.timezone })
      .from(schema.clinics)
      .where(eq(schema.clinics.id, clinicId))
      .limit(1);

    const context = createContext({
      correlationId: options.correlationId ?? `job-${randomUUID()}`,
      clinicId,
      clinicTimezone: clinic[0]?.timezone ?? "UTC",
      tx,
    });
    return runWithContext(context, fn);
  });
}
