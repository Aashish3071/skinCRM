import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  addLeadNoteSchema,
  assignLeadSchema,
  changeStageSchema,
  completeTaskSchema,
  createLeadSchema,
  createTaskSchema,
  listLeadsQuerySchema,
  listTasksQuerySchema,
  logContactAttemptSchema,
  snoozeTaskSchema,
  updateLeadSchema,
  uuidSchema,
  type LeadDto,
  type TaskDto,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, forbidden, notFound } from "../errors";
import { diffSummary, recordAudit } from "../audit";
import { registerRoute } from "../route";
import { emitAutomationEvent } from "../automations/engine";
import { markFirstResponse, slaDueFor } from "./sla";
import { createPerson, getPerson, DuplicatePersonError } from "../people/service";
import { AppError } from "../errors";
import { routeLead } from "./assignment";
import {
  addActivity,
  assignLead,
  changeStage,
  getLead,
  loadStages,
  stageByCategory,
} from "./service";

const { leads, pipelineStages, people, users, tasks, activities, leadStageEvents, clinics } = schema;

export function registerLeadRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "GET",
    url: "/leads/assignees",
    auth: { capability: "leads:assign" },
    handler: async () => ({ items: await getTx()
      .select({ id: users.id, fullName: users.fullName }).from(users)
      .where(and(isNull(users.archivedAt), eq(users.status, "active")))
      .orderBy(asc(users.fullName)) }),
  });
  // --- Pipeline -----------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/pipeline/stages",
    auth: { capability: "leads:read" },
    handler: async () => ({
      items: (await loadStages()).map((stage) => ({
        id: stage.id,
        name: stage.name,
        category: stage.category,
        position: stage.position,
        isClosed: stage.isClosed,
        requiresReason: stage.requiresReason,
      })),
    }),
  });

  // --- List and Kanban ----------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/leads",
    auth: { capability: "leads:read" },
    query: listLeadsQuerySchema,
    handler: async ({ query }) => {
      const tx = getTx();
      const context = getContext();
      const conditions = await buildLeadFilters(query);

      const rows = await tx
        .select(leadSelection)
        .from(leads)
        .innerJoin(people, eq(people.id, leads.personId))
        .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
        .leftJoin(users, eq(users.id, leads.ownerUserId))
        .where(and(...conditions))
        .orderBy(
          query.sort === "oldest"
            ? asc(leads.createdAt)
            : query.sort === "recently_updated"
              ? desc(leads.updatedAt)
              : desc(leads.createdAt),
        )
        .limit(query.limit)
        .offset(query.offset);

      const totals = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(leads)
        .innerJoin(people, eq(people.id, leads.personId))
        .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
        .where(and(...conditions));

      // Counts per stage for the Kanban headers. Computed with the same filters
      // so the board and the list can never disagree (PRD LEAD-01).
      const perStage = await tx
        .select({ stageId: leads.stageId, count: sql<number>`count(*)::int` })
        .from(leads)
        .innerJoin(people, eq(people.id, leads.personId))
        .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
        .where(and(...conditions))
        .groupBy(leads.stageId);

      return {
        items: rows.map(serializeLead),
        totalCount: totals[0]?.total ?? 0,
        stageCounts: Object.fromEntries(perStage.map((r) => [r.stageId, r.count])),
        viewerId: context.userId,
      };
    },
  });

  // --- Create (walk-in / manual intake, PRD ID-03) -----------------------
  registerRoute(app, {
    method: "POST",
    url: "/leads",
    auth: { capability: "leads:write" },
    body: createLeadSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();

      if (!body.personId && !body.person) {
        throw badRequest("Give an existing person, or the details to create one.");
      }

      // Resolve or create the person first; a lead cannot exist without one.
      let personId = body.personId ?? null;
      if (!personId && body.person) {
        const countryRows = await tx.select({ country: clinics.country }).from(clinics).limit(1);
        try {
          const created = await createPerson(
            { ...body.person, allowDuplicate: body.person.allowDuplicate ?? false },
            countryRows[0]?.country ?? "US",
          );
          personId = created.id;
        } catch (error) {
          if (error instanceof DuplicatePersonError) {
            throw new AppError(
              409,
              "duplicate_person",
              "Someone with these contact details already exists. Open their record to add this inquiry, or create a new person deliberately.",
              undefined,
              { candidates: error.candidates },
            );
          }
          throw error;
        }
      } else if (personId) {
        await getPerson(personId);
      }

      const newStage = await stageByCategory("new");

      /**
       * An explicit owner always wins — the person creating the lead knows
       * something the rules do not. Otherwise routing decides, and no match
       * means the unassigned queue (PRD LEAD-03).
       */
      const routing =
        body.ownerUserId === undefined || body.ownerUserId === null
          ? await routeLead({
              source: body.source,
              serviceInterest: body.serviceInterest ?? null,
              branchId: body.branchId ?? null,
            })
          : { ownerUserId: body.ownerUserId, ruleId: null, ruleName: null };

      const inserted = await tx
        .insert(leads)
        .values({
          clinicId: context.clinicId!,
          personId: personId!,
          source: body.source,
          stageId: newStage.id,
          ownerUserId: routing.ownerUserId,
          branchId: body.branchId ?? null,
          serviceInterest: body.serviceInterest ?? null,
          inquiryNote: body.inquiryNote ?? null,
          slaDueAt: await slaDueFor(new Date()),
        })
        .returning();

      const lead = inserted[0]!;

      await tx.insert(leadStageEvents).values({
        clinicId: context.clinicId!,
        leadId: lead.id,
        fromStageId: null,
        toStageId: newStage.id,
        actorUserId: context.userId,
        reason: null,
      });

      await addActivity({
        personId: lead.personId,
        leadId: lead.id,
        type: "source_submission",
        summary: `Inquiry created from ${body.source.replace(/_/g, " ")}`,
        body: body.inquiryNote ?? null,
      });

      if (routing.ruleId) {
        // Say which rule decided, so a surprising assignment is traceable
        // without reading the rule table.
        await addActivity({
          personId: lead.personId,
          leadId: lead.id,
          type: "assignment_change",
          summary: `Assigned by rule "${routing.ruleName}"`,
          metadata: { ruleId: routing.ruleId, to: routing.ownerUserId },
        });
      }

      await recordAudit({
        action: "record_created",
        entityType: "lead",
        entityId: lead.id,
        changeSummary: {
          source: body.source,
          assigned: routing.ownerUserId !== null,
          assignedByRuleId: routing.ruleId,
        },
      });

      await emitAutomationEvent({ type: "lead_created", leadId: lead.id, personId: lead.personId, source: body.source });

      return loadLeadDto(lead.id);
    },
  });

  // --- Read one -----------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/leads/:id",
    auth: { capability: "leads:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      await assertLeadVisible(params.id);
      return loadLeadDto(params.id);
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/leads/:id",
    auth: { capability: "leads:write" },
    params: z.object({ id: uuidSchema }),
    body: updateLeadSchema,
    handler: async ({ params, body }) => {
      const tx = getTx();
      const before = await getLead(params.id);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.serviceInterest !== undefined) updates.serviceInterest = body.serviceInterest;
      if (body.inquiryNote !== undefined) updates.inquiryNote = body.inquiryNote;
      if (body.branchId !== undefined) updates.branchId = body.branchId;
      // The original `source` is immutable after ingestion (BRD 7); a correction
      // is recorded alongside it rather than overwriting the evidence.
      if (body.reportingSource !== undefined) updates.reportingSource = body.reportingSource;

      await tx.update(leads).set(updates).where(eq(leads.id, params.id));

      await recordAudit({
        action: "record_updated",
        entityType: "lead",
        entityId: params.id,
        changeSummary: diffSummary(before as unknown as Record<string, unknown>, updates),
      });

      return loadLeadDto(params.id);
    },
  });

  // --- Stage and assignment ----------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/leads/:id/stage",
    auth: { capability: "leads:write" },
    params: z.object({ id: uuidSchema }),
    body: changeStageSchema,
    handler: async ({ params, body }) => {
      await changeStage({ leadId: params.id, stageId: body.stageId, reason: body.reason ?? null });
      return loadLeadDto(params.id);
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/leads/:id/assign",
    auth: { capability: "leads:assign" },
    params: z.object({ id: uuidSchema }),
    body: assignLeadSchema,
    handler: async ({ params, body }) => {
      await assignLead({
        leadId: params.id,
        ownerUserId: body.ownerUserId,
        note: body.note ?? null,
      });
      return loadLeadDto(params.id);
    },
  });

  // --- Timeline (PRD LEAD-04) --------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/leads/:id/timeline",
    auth: { capability: "leads:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const tx = getTx();
      await assertLeadVisible(params.id);

      const rows = await tx
        .select()
        .from(activities)
        .where(eq(activities.leadId, params.id))
        .orderBy(desc(activities.occurredAt));

      return {
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          summary: row.summary,
          body: row.body,
          outcome: row.outcome,
          actorLabel: row.actorLabel,
          metadata: row.metadata,
          occurredAt: row.occurredAt.toISOString(),
        })),
      };
    },
  });

  // --- Contact attempts and inquiry notes (PRD LEAD-06) ------------------
  registerRoute(app, {
    method: "POST",
    url: "/leads/:id/contact-attempts",
    auth: { capability: "leads:write" },
    params: z.object({ id: uuidSchema }),
    body: logContactAttemptSchema,
    status: 201,
    handler: async ({ params, body }) => {
      const tx = getTx();
      const lead = await getLead(params.id);

      await addActivity({
        personId: lead.personId,
        leadId: lead.id,
        type: "call",
        summary: `Contact attempt by ${body.channel.replace(/_/g, " ")}: ${body.outcome.replace(/_/g, " ")}`,
        body: body.note ?? null,
        outcome: body.outcome,
        metadata: { channel: body.channel },
      });

      // First successful contact is a reportable milestone (BRD 3: response speed).
      // Any attempt — answered or not — is a response for the SLA (D-73).
      await markFirstResponse(lead.id);
      if (body.outcome === "connected" && !lead.firstContactedAt) {
        await tx
          .update(leads)
          .set({ firstContactedAt: new Date(), updatedAt: new Date() })
          .where(eq(leads.id, lead.id));
      }

      if (body.stageId) {
        await changeStage({ leadId: lead.id, stageId: body.stageId, silent: true });
      }

      return loadLeadDto(lead.id);
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/leads/:id/notes",
    auth: { capability: "leads:write" },
    params: z.object({ id: uuidSchema }),
    body: addLeadNoteSchema,
    status: 201,
    handler: async ({ params, body }) => {
      const lead = await getLead(params.id);
      // An inquiry note is scoped to this lead, unlike a General Note which
      // belongs to the person and follows them across inquiries (PRD LEAD-06).
      await addActivity({
        personId: lead.personId,
        leadId: lead.id,
        type: "note",
        summary: "Note added to this inquiry",
        body: body.body,
      });
      return { ok: true };
    },
  });

  // --- Tasks (PRD LEAD-05) ------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/tasks",
    auth: { capability: "tasks:read" },
    query: listTasksQuerySchema,
    handler: async ({ query }) => {
      const tx = getTx();
      const context = getContext();

      const conditions = [];
      if (query.mine) conditions.push(eq(tasks.ownerUserId, context.userId!));
      else if (query.ownerUserId) conditions.push(eq(tasks.ownerUserId, query.ownerUserId));
      if (query.status) conditions.push(eq(tasks.status, query.status));
      if (query.leadId) conditions.push(eq(tasks.leadId, query.leadId));

      const now = new Date();
      if (query.dueView === "overdue") {
        conditions.push(lte(tasks.dueAt, now), eq(tasks.status, "open"));
      } else if (query.dueView === "today") {
        conditions.push(lte(tasks.dueAt, endOfClinicDay(now, context.clinicTimezone)));
        conditions.push(eq(tasks.status, "open"));
      } else if (query.dueView === "upcoming") {
        conditions.push(gte(tasks.dueAt, now), eq(tasks.status, "open"));
      }

      const rows = await tx
        .select({
          task: tasks,
          personName: people.displayName,
          ownerName: users.fullName,
          leadStageClosed: pipelineStages.isClosed,
        })
        .from(tasks)
        .leftJoin(people, eq(people.id, tasks.personId))
        .leftJoin(users, eq(users.id, tasks.ownerUserId))
        .leftJoin(leads, eq(leads.id, tasks.leadId))
        .leftJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        // Soonest first: this view opens every shift and the top row is the
        // thing most overdue.
        .orderBy(asc(tasks.dueAt))
        .limit(query.limit)
        .offset(query.offset);

      return { items: rows.map(serializeTask) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/tasks",
    auth: { capability: "tasks:write" },
    body: createTaskSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      const tx = getTx();

      let personId = body.personId ?? null;
      if (body.leadId) {
        const lead = await getLead(body.leadId);
        personId = lead.personId;
      } else if (personId) {
        await getPerson(personId);
      }

      const inserted = await tx
        .insert(tasks)
        .values({
          clinicId: context.clinicId!,
          leadId: body.leadId ?? null,
          personId,
          title: body.title,
          detail: body.detail ?? null,
          ownerUserId: body.ownerUserId ?? context.userId,
          dueAt: new Date(body.dueAt),
          priority: body.priority,
          createdByUserId: context.userId,
        })
        .returning();

      if (personId) {
        await addActivity({
          personId,
          leadId: body.leadId ?? null,
          type: "task_created",
          summary: `Task created: ${body.title}`,
          entityType: "task",
          entityId: inserted[0]!.id,
        });
      }

      return loadTaskDto(inserted[0]!.id);
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/tasks/:id/complete",
    auth: { capability: "tasks:write" },
    params: z.object({ id: uuidSchema }),
    body: completeTaskSchema,
    handler: async ({ params, body }) => {
      const context = getContext();
      const tx = getTx();
      const task = await loadTask(params.id);

      if (task.status === "completed") {
        throw badRequest("That task is already complete.");
      }

      await tx
        .update(tasks)
        .set({
          status: "completed",
          // An outcome is mandatory; the schema guarantees one is present.
          outcome: body.outcome,
          outcomeNote: body.outcomeNote ?? null,
          completedAt: new Date(),
          completedByUserId: context.userId,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      if (task.personId) {
        await addActivity({
          personId: task.personId,
          leadId: task.leadId,
          type: "task_completed",
          summary: `Task completed: ${task.title}`,
          body: body.outcomeNote ?? null,
          outcome: body.outcome,
          entityType: "task",
          entityId: task.id,
        });
      }

      return loadTaskDto(task.id);
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/tasks/:id/snooze",
    auth: { capability: "tasks:write" },
    params: z.object({ id: uuidSchema }),
    body: snoozeTaskSchema,
    handler: async ({ params, body }) => {
      const tx = getTx();
      const task = await loadTask(params.id);
      const newDue = new Date(body.dueAt);

      // Snoozing must move the work forward, not hide it (PRD LEAD-05).
      if (newDue.getTime() <= Date.now()) {
        throw badRequest("Pick a new due time in the future.", {
          dueAt: ["Must be later than now"],
        });
      }

      await tx
        .update(tasks)
        .set({
          dueAt: newDue,
          snoozedFrom: task.dueAt,
          status: "open",
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      return loadTaskDto(task.id);
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/leads/:id/tasks",
    auth: { capability: "tasks:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const tx = getTx();
      await assertLeadVisible(params.id);
      const rows = await tx
        .select({
          task: tasks,
          personName: people.displayName,
          ownerName: users.fullName,
          leadStageClosed: pipelineStages.isClosed,
        })
        .from(tasks)
        .leftJoin(people, eq(people.id, tasks.personId))
        .leftJoin(users, eq(users.id, tasks.ownerUserId))
        .leftJoin(leads, eq(leads.id, tasks.leadId))
        .leftJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
        .where(eq(tasks.leadId, params.id))
        .orderBy(asc(tasks.dueAt));
      return { items: rows.map(serializeTask) };
    },
  });
}

// --- Helpers --------------------------------------------------------------

const leadSelection = {
  lead: leads,
  personName: people.displayName,
  personPhone: people.phoneRaw,
  personEmail: people.emailRaw,
  stageName: pipelineStages.name,
  stageCategory: pipelineStages.category,
  stageClosed: pipelineStages.isClosed,
  ownerName: users.fullName,
  // Furthest open stage ever reached, so the UI can grey out earlier ones (D-69).
  furthestPosition: sql<number | null>`(
    select max(ps.position) from lead_stage_events e
    join pipeline_stages ps on ps.id = e.to_stage_id
    where e.lead_id = ${leads.id} and ps.is_active and not ps.is_closed
  )`,
};

type LeadJoinRow = {
  lead: typeof leads.$inferSelect;
  personName: string;
  personPhone: string | null;
  personEmail: string | null;
  stageName: string;
  stageCategory: LeadDto["stageCategory"];
  stageClosed: boolean;
  ownerName: string | null;
  furthestPosition: number | null;
};

function serializeLead(row: LeadJoinRow): LeadDto {
  const { lead } = row;
  return {
    id: lead.id,
    personId: lead.personId,
    personName: row.personName,
    personPhone: row.personPhone,
    personEmail: row.personEmail,
    furthestPosition: row.furthestPosition,
    source: lead.source,
    reportingSource: lead.reportingSource,
    stageId: lead.stageId,
    stageName: row.stageName,
    stageCategory: row.stageCategory,
    isClosed: row.stageClosed,
    ownerUserId: lead.ownerUserId,
    ownerName: row.ownerName,
    branchId: lead.branchId,
    serviceInterest: lead.serviceInterest,
    inquiryNote: lead.inquiryNote,
    isTest: lead.isTest,
    firstContactedAt: lead.firstContactedAt?.toISOString() ?? null,
    firstResponseAt: lead.firstResponseAt?.toISOString() ?? null,
    slaDueAt: lead.slaDueAt?.toISOString() ?? null,
    slaBreachedAt: lead.slaBreachedAt?.toISOString() ?? null,
    qualifiedAt: lead.qualifiedAt?.toISOString() ?? null,
    bookedAt: lead.bookedAt?.toISOString() ?? null,
    attendedAt: lead.attendedAt?.toISOString() ?? null,
    convertedAt: lead.convertedAt?.toISOString() ?? null,
    closedAt: lead.closedAt?.toISOString() ?? null,
    lossReason: lead.lossReason,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

async function loadLeadDto(leadId: string): Promise<LeadDto> {
  const tx = getTx();
  const rows = await tx
    .select(leadSelection)
    .from(leads)
    .innerJoin(people, eq(people.id, leads.personId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
    .leftJoin(users, eq(users.id, leads.ownerUserId))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!rows[0]) throw notFound("No such lead.");
  return serializeLead(rows[0] as LeadJoinRow);
}

/**
 * Narrow the query by what this role may see (PRD 2).
 *
 * A practitioner has `leads:read` but not `leads:read_all`, so they see only
 * leads assigned to them plus the unassigned queue. Enforced in SQL rather than
 * by filtering after the fact, so the count and the rows always agree.
 */
async function buildLeadFilters(query: {
  search?: string | null;
  stageCategory?: LeadDto["stageCategory"];
  stageId?: string;
  ownerUserId?: string;
  unassigned?: boolean;
  source?: LeadDto["source"];
  branchId?: string;
  createdFrom?: string;
  createdTo?: string;
  includeClosed: boolean;
  includeTest: boolean;
  awaitingResponse?: boolean;
}) {
  const context = getContext();
  const conditions = [isNull(leads.archivedAt)];

  if (!context.capabilities.has("leads:read_all")) {
    conditions.push(or(eq(leads.ownerUserId, context.userId!), isNull(leads.ownerUserId))!);
  }

  if (query.stageCategory) conditions.push(eq(pipelineStages.category, query.stageCategory));
  if (query.stageId) conditions.push(eq(leads.stageId, query.stageId));
  if (query.unassigned) conditions.push(isNull(leads.ownerUserId));
  else if (query.ownerUserId) conditions.push(eq(leads.ownerUserId, query.ownerUserId));
  if (query.source) conditions.push(eq(leads.source, query.source));
  if (query.branchId) conditions.push(eq(leads.branchId, query.branchId));
  if (!query.includeClosed) conditions.push(eq(pipelineStages.isClosed, false));
  // Test submissions are excluded by default so they cannot inflate reporting.
  if (!query.includeTest) conditions.push(eq(leads.isTest, false));
  if (query.awaitingResponse) {
    conditions.push(isNull(leads.firstResponseAt), isNull(leads.closedAt), isNotNull(leads.slaDueAt));
  }

  if (query.createdFrom) conditions.push(gte(leads.createdAt, new Date(query.createdFrom)));
  if (query.createdTo) conditions.push(lte(leads.createdAt, new Date(query.createdTo)));

  if (query.search) {
    const pattern = `%${query.search}%`;
    conditions.push(
      or(
        ilike(people.displayName, pattern),
        ilike(people.emailRaw, pattern),
        ilike(people.phoneRaw, pattern),
        ilike(leads.serviceInterest, pattern),
      )!,
    );
  }

  return conditions;
}

async function assertLeadVisible(leadId: string): Promise<void> {
  const context = getContext();
  const lead = await getLead(leadId);
  if (context.capabilities.has("leads:read_all")) return;
  // Same reasoning as the list filter: own plus the unassigned queue.
  if (lead.ownerUserId === null || lead.ownerUserId === context.userId) return;
  throw forbidden("That lead is assigned to someone else.");
}

async function loadTask(taskId: string) {
  const tx = getTx();
  const rows = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const task = rows[0];
  if (!task) throw notFound("No such task.");
  return task;
}

async function loadTaskDto(taskId: string): Promise<TaskDto> {
  const tx = getTx();
  const rows = await tx
    .select({
      task: tasks,
      personName: people.displayName,
      ownerName: users.fullName,
      leadStageClosed: pipelineStages.isClosed,
    })
    .from(tasks)
    .leftJoin(people, eq(people.id, tasks.personId))
    .leftJoin(users, eq(users.id, tasks.ownerUserId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .leftJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!rows[0]) throw notFound("No such task.");
  return serializeTask(rows[0]);
}

function serializeTask(row: {
  task: typeof tasks.$inferSelect;
  personName: string | null;
  ownerName: string | null;
  leadStageClosed: boolean | null;
}): TaskDto {
  const { task } = row;
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    leadId: task.leadId,
    personId: task.personId,
    personName: row.personName,
    ownerUserId: task.ownerUserId,
    ownerName: row.ownerName,
    dueAt: task.dueAt.toISOString(),
    status: task.status,
    priority: task.priority,
    outcome: task.outcome,
    outcomeNote: task.outcomeNote,
    completedAt: task.completedAt?.toISOString() ?? null,
    // Surfaced so a task on a closed lead is visibly handled rather than
    // silently lingering in someone's queue (PRD LEAD-05).
    leadClosed: row.leadStageClosed ?? false,
    createdAt: task.createdAt.toISOString(),
  };
}

/**
 * End of the current day in the clinic's timezone, as a UTC instant.
 *
 * "Due today" has to mean the clinic's today. Computing it in the server's
 * timezone would put the boundary in the wrong place, which is visible to staff
 * every evening (PRD CAL-01, LEAD-05).
 */
function endOfClinicDay(now: Date, timezone: string | null): Date {
  const tz = timezone ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const localDate = `${get("year")}-${get("month")}-${get("day")}`;

  // Find the UTC instant corresponding to 23:59:59.999 local on that date by
  // measuring the zone's offset at that moment.
  const guess = new Date(`${localDate}T23:59:59.999Z`);
  const offsetMs = zoneOffsetMs(guess, tz);
  return new Date(guess.getTime() - offsetMs);
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - at.getTime();
}
