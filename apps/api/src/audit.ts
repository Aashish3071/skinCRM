import type { AuditAction } from "@skincrm/contracts";
import { schema, withTenant } from "@skincrm/db";
import { getContext, tryGetContext } from "./context";
import { logger, redactForAudit } from "./logger";

const { auditEvents } = schema;

export interface AuditInput {
  action: AuditAction;
  entityType?: string;
  entityId?: string | null;
  /**
   * Before/after summary. Passed through `redactForAudit`, so contact details,
   * note bodies, message bodies and secrets are replaced with `[redacted]`
   * while the fact that they changed is still recorded (PRD 8).
   */
  changeSummary?: Record<string, unknown>;
  /** Override when the acting user is not the session user (system jobs). */
  actorUserId?: string | null;
  actorLabel?: string | null;
  /** Override when the write must land in a clinic other than the caller's. */
  clinicId?: string;
}

/**
 * Append an audit entry (PRD AUD-01).
 *
 * Writes inside the caller's tenant transaction when there is one, so an audited
 * change and its audit row commit together — a rolled-back change leaves no
 * misleading entry. Falls back to its own transaction for events that happen
 * outside a tenant transaction, such as a failed login.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  const context = tryGetContext();
  const clinicId = input.clinicId ?? context?.clinicId;
  if (!clinicId) {
    // Nothing to attach it to. Log loudly rather than silently dropping it.
    logger.warn({ action: input.action }, "Audit event without a clinic id was not persisted");
    return;
  }

  const values = {
    clinicId,
    actorUserId: input.actorUserId ?? context?.userId ?? null,
    actorLabel: input.actorLabel ?? null,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    changeSummary: (redactForAudit(input.changeSummary ?? {}) ?? {}) as Record<string, unknown>,
    ipAddress: context?.ipAddress ?? null,
    userAgent: context?.userAgent ?? null,
    correlationId: context?.correlationId ?? null,
  };

  if (context?.tx) {
    await context.tx.insert(auditEvents).values(values);
    return;
  }
  await withTenant(clinicId, async (tx) => {
    await tx.insert(auditEvents).values(values);
  });
}

/**
 * Record that someone opened a record whose contents are sensitive (PRD AUD-01:
 * "sensitive record access"). Kept separate so the call reads clearly at the
 * point of use and cannot be confused with a mutation.
 */
export async function recordSensitiveAccess(entityType: string, entityId: string): Promise<void> {
  const context = getContext();
  await recordAudit({
    action: "sensitive_record_viewed",
    entityType,
    entityId,
    changeSummary: { role: context.role },
  });
}

/**
 * Summarize a change as field names plus redacted values. Use for
 * `changeSummary` so an entry says what changed without duplicating the data
 * into a second, less-protected place.
 */
export function diffSummary<T extends Record<string, unknown>>(
  before: T | null,
  after: Partial<T>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, nextValue] of Object.entries(after)) {
    const previousValue = before ? before[key] : undefined;
    if (JSON.stringify(previousValue) === JSON.stringify(nextValue)) continue;
    changed[key] = { from: previousValue ?? null, to: nextValue ?? null };
  }
  return changed;
}
