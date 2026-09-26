import { and, eq, isNull } from "drizzle-orm";
import {
  CLOSED_STAGE_CATEGORIES,
  REASON_REQUIRED_STAGE_CATEGORIES,
  STAGE_MILESTONE_FIELD,
  type ActivityType,
  type StageCategory,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, notFound } from "../errors";
import { recordAudit } from "../audit";

const { leads, leadStageEvents, pipelineStages, activities, users, people } = schema;

export type StageRow = typeof pipelineStages.$inferSelect;
export type LeadRow = typeof leads.$inferSelect;

/** The clinic's stages, in display order. Small table; loaded per request. */
export async function loadStages(): Promise<StageRow[]> {
  const tx = getTx();
  return tx
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.isActive, true))
    .orderBy(pipelineStages.position);
}

export async function stageById(stageId: string): Promise<StageRow> {
  const tx = getTx();
  const rows = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, stageId)).limit(1);
  const stage = rows[0];
  if (!stage) throw badRequest("That stage does not belong to this clinic.");
  return stage;
}

export async function stageByCategory(category: StageCategory): Promise<StageRow> {
  const tx = getTx();
  const rows = await tx
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.category, category))
    .limit(1);
  const stage = rows[0];
  if (!stage) {
    throw badRequest(`This clinic has no stage for "${category}". Check the pipeline settings.`);
  }
  return stage;
}

export async function getLead(leadId: string): Promise<LeadRow> {
  const tx = getTx();
  const rows = await tx.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  const lead = rows[0];
  // RLS confines this to the caller's clinic; a miss is "not found" either way.
  if (!lead) throw notFound("No such lead.");
  return lead;
}

/**
 * Move a lead to a new stage (PRD LEAD-02).
 *
 * Does four things atomically, inside the request transaction:
 *   1. enforces a reason where the stage requires one,
 *   2. stamps the milestone timestamp if this is the first time it is reached,
 *   3. writes a stage event with actor, time and reason,
 *   4. writes a timeline activity.
 *
 * Milestones are stamped once and never moved. A lead that bounces back and
 * forth keeps its original "when did this actually happen", which is what
 * conversion feedback reports and what stops one outcome being counted twice.
 */
export async function changeStage(params: {
  leadId: string;
  stageId: string;
  reason?: string | null;
  /** Suppresses the timeline entry when the caller writes a richer one. */
  silent?: boolean;
}): Promise<LeadRow> {
  const context = getContext();
  const tx = getTx();

  const lead = await getLead(params.leadId);
  const toStage = await stageById(params.stageId);

  if (lead.stageId === toStage.id) return lead;
  if (!toStage.isActive) throw badRequest(`${toStage.name} is no longer part of the pipeline.`);

  const fromStage = await stageById(lead.stageId);
  const reason = params.reason?.trim() || null;

  if (toStage.requiresReason && !reason) {
    throw badRequest(`Moving a lead to ${toStage.name} needs a reason.`, {
      reason: [`A reason is required to mark a lead ${toStage.name}`],
    });
  }

  const now = new Date();
  const updates: Record<string, unknown> = { stageId: toStage.id, updatedAt: now };

  // Stamp the milestone only on first arrival.
  const milestoneField = STAGE_MILESTONE_FIELD[toStage.category];
  if (milestoneField && lead[milestoneField as keyof LeadRow] == null) {
    updates[milestoneField] = now;
    if (toStage.category === "qualified") updates.qualifiedByUserId = context.userId;
  }

  if (toStage.isClosed) {
    updates.closedAt = lead.closedAt ?? now;
    if (REASON_REQUIRED_STAGE_CATEGORIES.includes(toStage.category)) {
      updates.lossReason = reason;
    }
  } else if (fromStage.isClosed) {
    // Reopened. Clear the closure so it stops counting as closed, but leave the
    // milestone timestamps alone — those record what genuinely happened.
    updates.closedAt = null;
    updates.lossReason = null;
  }

  const updated = await tx.update(leads).set(updates).where(eq(leads.id, lead.id)).returning();

  await tx.insert(leadStageEvents).values({
    clinicId: context.clinicId!,
    leadId: lead.id,
    fromStageId: fromStage.id,
    toStageId: toStage.id,
    actorUserId: context.userId,
    reason,
    occurredAt: now,
  });

  // Imported lazily: the engine itself calls changeStage for "Move lead" steps.
  const { emitAutomationEvent } = await import("../automations/engine");
  await emitAutomationEvent({
    type: "stage_changed",
    leadId: lead.id,
    personId: lead.personId,
    stageCategory: toStage.category,
  });

  if (!params.silent) {
    await addActivity({
      personId: lead.personId,
      leadId: lead.id,
      type: "stage_change",
      summary: `Stage changed from ${fromStage.name} to ${toStage.name}`,
      body: reason,
      occurredAt: now,
      metadata: { fromCategory: fromStage.category, toCategory: toStage.category },
    });
  }

  await recordAudit({
    action: "record_updated",
    entityType: "lead",
    entityId: lead.id,
    changeSummary: {
      stage: { from: fromStage.category, to: toStage.category },
      reasonGiven: reason !== null,
    },
  });

  return updated[0]!;
}

export async function assignLead(params: {
  leadId: string;
  ownerUserId: string | null;
  note?: string | null;
}): Promise<LeadRow> {
  const tx = getTx();
  const lead = await getLead(params.leadId);

  if (params.ownerUserId) {
    // RLS means a user from another clinic simply will not be found, which
    // would otherwise fail silently as a no-op.
    const owner = await tx
      .select({ id: users.id, fullName: users.fullName, status: users.status })
      .from(users)
      .where(and(eq(users.id, params.ownerUserId), isNull(users.archivedAt)))
      .limit(1);
    if (!owner[0]) throw badRequest("That person is not an active member of staff here.");
  }

  if (lead.ownerUserId === params.ownerUserId) return lead;

  const updated = await tx
    .update(leads)
    .set({ ownerUserId: params.ownerUserId, updatedAt: new Date() })
    .where(eq(leads.id, lead.id))
    .returning();

  await addActivity({
    personId: lead.personId,
    leadId: lead.id,
    type: "assignment_change",
    summary: params.ownerUserId ? "Lead assigned" : "Lead returned to the unassigned queue",
    body: params.note ?? null,
    metadata: { from: lead.ownerUserId, to: params.ownerUserId },
  });

  await recordAudit({
    action: "record_updated",
    entityType: "lead",
    entityId: lead.id,
    changeSummary: { owner: { from: lead.ownerUserId, to: params.ownerUserId } },
  });

  return updated[0]!;
}

/**
 * Append to the unified timeline (PRD LEAD-04). Everything that happens to a
 * lead lands here so one ordered query renders its history.
 */
export async function addActivity(params: {
  personId: string;
  leadId?: string | null;
  type: ActivityType;
  summary: string;
  body?: string | null;
  outcome?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}): Promise<void> {
  const context = getContext();
  const tx = getTx();

  await tx.insert(activities).values({
    clinicId: context.clinicId!,
    personId: params.personId,
    leadId: params.leadId ?? null,
    type: params.type,
    summary: params.summary,
    body: params.body ?? null,
    outcome: params.outcome ?? null,
    actorUserId: context.userId,
    actorLabel: await actorLabel(),
    entityType: params.entityType ?? null,
    entityId: params.entityId ?? null,
    metadata: params.metadata ?? {},
    occurredAt: params.occurredAt ?? new Date(),
  });
}

/**
 * The acting user's name, denormalized onto the activity so the timeline still
 * reads correctly after that account is archived.
 *
 * Deliberately not memoized in module scope: a cache living outside the request
 * is shared state in a multi-tenant process, and the lookup is a single indexed
 * read inside the transaction that is already open.
 */
async function actorLabel(): Promise<string | null> {
  const context = getContext();
  if (!context.userId) return "system";
  const tx = getTx();
  const rows = await tx
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, context.userId))
    .limit(1);
  return rows[0]?.fullName ?? null;
}

/** True when the category closes a lead. Used to decide nurture eligibility. */
export function isClosedCategory(category: StageCategory): boolean {
  return CLOSED_STAGE_CATEGORIES.includes(category);
}

export async function personDisplayName(personId: string): Promise<string> {
  const tx = getTx();
  const rows = await tx
    .select({ displayName: people.displayName })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  return rows[0]?.displayName ?? "Unknown";
}
