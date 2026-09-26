import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  saveAutomationSchema,
  setAutomationStatusSchema,
  testAutomationSchema,
  uuidSchema,
  type AutomationDto,
  type EnrollmentDto,
  type SaveAutomation,
  type TestRunLine,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { getLead } from "../leads/service";
import { ALL_TEMPLATE_VARIABLE_NAMES, TEMPLATE_VARIABLES, renderTemplate, validateTemplateBody } from "../messaging/render";
import { evaluateSend, resolveDestination } from "../messaging/send-gate";
import { resolveVariables } from "../messaging/service";
import { describeStep, latestLeadId, PROMOTIONAL_EMAIL_FOOTER, stopRunsForRule } from "./engine";

const { automationRules, automationEnrollments, messageTemplates, pipelineStages, people, appointments } = schema;

export function registerAutomationRoutes(app: FastifyInstance): void {
  // --- What the canvas can offer -------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/automations/options",
    auth: { capability: "automations:read" },
    handler: async () => {
      const tx = getTx();
      const [stages, templates] = await Promise.all([
        tx
          .select({ category: pipelineStages.category, name: pipelineStages.name })
          .from(pipelineStages)
          .where(eq(pipelineStages.isActive, true))
          .orderBy(pipelineStages.position),
        tx
          .select({
            key: messageTemplates.key,
            name: messageTemplates.name,
            channel: messageTemplates.channel,
            classification: messageTemplates.classification,
            whatsappTemplateName: messageTemplates.whatsappTemplateName,
            whatsappStatus: messageTemplates.whatsappStatus,
          })
          .from(messageTemplates)
          .where(and(eq(messageTemplates.isActive, true), isNull(messageTemplates.archivedAt)))
          .orderBy(messageTemplates.name),
      ]);
      return {
        stages,
        templates,
        variables: Object.entries(TEMPLATE_VARIABLES).map(([name, description]) => ({ name, description })),
      };
    },
  });

  // --- List ------------------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/automations",
    auth: { capability: "automations:read" },
    handler: async () => {
      const tx = getTx();
      const rows = await tx
        .select()
        .from(automationRules)
        .where(isNull(automationRules.archivedAt))
        .orderBy(desc(automationRules.updatedAt));
      const counts = await runCounts();
      return { items: rows.map((row) => serializeRule(row, counts.get(row.id))) };
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/automations/:id",
    auth: { capability: "automations:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const row = await loadRule(params.id);
      const counts = await runCounts(row.id);
      return serializeRule(row, counts.get(row.id));
    },
  });

  // --- Create and save -------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/automations",
    auth: { capability: "automations:write" },
    body: saveAutomationSchema,
    status: 201,
    handler: async ({ body }) => {
      const context = getContext();
      await assertRuleIsUsable(body);
      const inserted = await getTx()
        .insert(automationRules)
        .values({
          clinicId: context.clinicId!,
          name: body.name,
          // Always paused on creation: switching it on is a separate, deliberate act.
          status: "paused",
          triggerType: body.trigger.type,
          trigger: body.trigger,
          steps: body.steps,
          stopWhen: body.stopWhen,
          createdByUserId: context.userId,
        })
        .returning();
      await recordAudit({
        action: "automation_rule_changed",
        entityType: "automation_rule",
        entityId: inserted[0]!.id,
        changeSummary: { created: true, trigger: body.trigger.type, steps: body.steps.map((s) => s.type) },
      });
      return serializeRule(inserted[0]!, undefined);
    },
  });

  registerRoute(app, {
    method: "PUT",
    url: "/automations/:id",
    auth: { capability: "automations:write" },
    params: z.object({ id: uuidSchema }),
    body: saveAutomationSchema,
    handler: async ({ params, body }) => {
      const before = await loadRule(params.id);
      await assertRuleIsUsable(body);
      // Runs already in flight keep the steps they started with (see schema).
      const updated = await getTx()
        .update(automationRules)
        .set({
          name: body.name,
          triggerType: body.trigger.type,
          trigger: body.trigger,
          steps: body.steps,
          stopWhen: body.stopWhen,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(automationRules.id, before.id))
        .returning();
      await recordAudit({
        action: "automation_rule_changed",
        entityType: "automation_rule",
        entityId: before.id,
        changeSummary: { version: before.version + 1, trigger: body.trigger.type, steps: body.steps.map((s) => s.type) },
      });
      const counts = await runCounts(before.id);
      return serializeRule(updated[0]!, counts.get(before.id));
    },
  });

  // --- On / off --------------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/automations/:id/status",
    auth: { capability: "automations:write" },
    params: z.object({ id: uuidSchema }),
    body: setAutomationStatusSchema,
    handler: async ({ params, body }) => {
      const before = await loadRule(params.id);
      if (body.status === "active") {
        // Re-validate: a template or stage it depends on may have gone since it was saved.
        await assertRuleIsUsable({
          name: before.name,
          trigger: before.trigger,
          steps: before.steps,
          stopWhen: before.stopWhen,
        });
      }
      let stopped = 0;
      if (body.status !== "active" && before.status === "active") {
        stopped = await stopRunsForRule(before.id, "The automation was paused");
      }
      const updated = await getTx()
        .update(automationRules)
        .set({ status: body.status, updatedAt: new Date() })
        .where(eq(automationRules.id, before.id))
        .returning();
      await recordAudit({
        action: "automation_rule_changed",
        entityType: "automation_rule",
        entityId: before.id,
        changeSummary: { status: { from: before.status, to: body.status }, runsStopped: stopped },
      });
      const counts = await runCounts(before.id);
      return serializeRule(updated[0]!, counts.get(before.id));
    },
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/automations/:id",
    auth: { capability: "automations:write" },
    params: z.object({ id: uuidSchema }),
    status: 204,
    handler: async ({ params }) => {
      const before = await loadRule(params.id);
      await stopRunsForRule(before.id, "The automation was deleted");
      // Archived, not deleted: the delivery log still points at it.
      await getTx()
        .update(automationRules)
        .set({ archivedAt: new Date(), status: "paused", updatedAt: new Date() })
        .where(eq(automationRules.id, before.id));
      await recordAudit({
        action: "automation_rule_changed",
        entityType: "automation_rule",
        entityId: before.id,
        changeSummary: { archived: true },
      });
      return undefined;
    },
  });

  // --- Runs (PRD MSG-03: "inspect enrollment") -------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/automations/:id/runs",
    auth: { capability: "automations:read" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const rule = await loadRule(params.id);
      const rows = await getTx()
        .select({ run: automationEnrollments, personName: people.displayName })
        .from(automationEnrollments)
        .innerJoin(people, eq(people.id, automationEnrollments.personId))
        .where(eq(automationEnrollments.ruleId, rule.id))
        .orderBy(desc(automationEnrollments.startedAt))
        .limit(100);
      return {
        items: rows.map(
          ({ run, personName }): EnrollmentDto => ({
            id: run.id,
            personId: run.personId,
            personName,
            leadId: run.leadId,
            appointmentId: run.appointmentId,
            state: run.state,
            currentStep: run.currentStep,
            nextRunAt: run.nextRunAt?.toISOString() ?? null,
            stopReason: run.stopReason,
            history: run.history,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
          }),
        ),
      };
    },
  });

  // --- Dry run (PRD MSG-03: "test with sample lead") -------------------------
  registerRoute(app, {
    method: "POST",
    url: "/automations/test",
    auth: { capability: "automations:write" },
    body: saveAutomationSchema.and(testAutomationSchema),
    handler: async ({ body }) => dryRun(body, body.leadId),
  });
}

async function loadRule(id: string) {
  const rows = await getTx()
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.id, id), isNull(automationRules.archivedAt)))
    .limit(1);
  if (!rows[0]) throw notFound("No such automation.");
  return rows[0];
}

async function runCounts(ruleId?: string) {
  const rows = await getTx()
    .select({
      ruleId: automationEnrollments.ruleId,
      active: sql<number>`count(*) filter (where ${automationEnrollments.state} = 'active')::int`,
      completed: sql<number>`count(*) filter (where ${automationEnrollments.state} = 'completed')::int`,
    })
    .from(automationEnrollments)
    .where(ruleId ? eq(automationEnrollments.ruleId, ruleId) : undefined)
    .groupBy(automationEnrollments.ruleId);
  return new Map(rows.map((r) => [r.ruleId, { active: r.active, completed: r.completed }]));
}

function serializeRule(
  row: typeof automationRules.$inferSelect,
  counts: { active: number; completed: number } | undefined,
): AutomationDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    trigger: row.trigger,
    steps: row.steps,
    stopWhen: row.stopWhen,
    version: row.version,
    activeCount: counts?.active ?? 0,
    completedCount: counts?.completed ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Checks the schema cannot: that templates and stages exist in this clinic,
 * that channels match, and that written copy only uses real variables. Caught
 * on save rather than as a failed send at 9am tomorrow.
 */
async function assertRuleIsUsable(rule: SaveAutomation): Promise<void> {
  const tx = getTx();
  const errors: Record<string, string[]> = {};
  const add = (path: string, message: string) => {
    (errors[path] ??= []).push(message);
  };

  const stages = await tx
    .select({ category: pipelineStages.category })
    .from(pipelineStages)
    .where(eq(pipelineStages.isActive, true));
  const activeCategories = new Set(stages.map((s) => s.category));

  if (rule.trigger.type === "stage_changed" && !activeCategories.has(rule.trigger.stageCategory)) {
    add("trigger", "That stage is not part of this clinic's pipeline");
  }

  const templateKeys = rule.steps.flatMap((s) =>
    (s.type === "send_email" || s.type === "send_whatsapp") && s.templateKey ? [s.templateKey] : [],
  );
  const templates = templateKeys.length
    ? await tx
        .select({ key: messageTemplates.key, channel: messageTemplates.channel, isActive: messageTemplates.isActive, archivedAt: messageTemplates.archivedAt })
        .from(messageTemplates)
    : [];
  const byKey = new Map(templates.map((t) => [t.key, t]));

  rule.steps.forEach((step, index) => {
    const path = `steps.${index}`;
    if (step.type === "move_stage" && !activeCategories.has(step.stageCategory)) {
      add(path, "That stage is not part of this clinic's pipeline");
    }
    if (step.type === "send_email" || step.type === "send_whatsapp") {
      const channel = step.type === "send_email" ? "email" : "whatsapp";
      if (step.templateKey) {
        const template = byKey.get(step.templateKey);
        if (!template || !template.isActive || template.archivedAt) add(path, "That template no longer exists");
        else if (template.channel !== channel) add(path, `That template is for ${template.channel}, not ${channel}`);
      } else {
        for (const text of [step.body, step.type === "send_email" ? step.subject : null]) {
          if (!text) continue;
          const { unknownVariables } = validateTemplateBody(text, ALL_TEMPLATE_VARIABLE_NAMES);
          if (unknownVariables.length) add(path, `Unknown variables: ${unknownVariables.map((v) => `{{${v}}}`).join(", ")}`);
        }
      }
    }
  });

  if (Object.keys(errors).length > 0) {
    throw badRequest("Some steps need fixing before this can be saved.", errors);
  }
}

/**
 * What each step would do for one real lead, right now. Sends nothing and
 * writes nothing: the gate is evaluated with a throwaway idempotency key and
 * the rendered text is returned instead of delivered.
 */
async function dryRun(rule: SaveAutomation, leadId: string | undefined) {
  const tx = getTx();
  const context = getContext();
  await assertRuleIsUsable(rule);

  const sampleLeadId = leadId ?? (await latestLeadId());
  if (!sampleLeadId) throw badRequest("Add a lead first — the test runs against a real one.");
  const lead = await getLead(sampleLeadId);
  const person = (await tx.select({ name: people.displayName }).from(people).where(eq(people.id, lead.personId)).limit(1))[0];

  const appointment = (
    await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.personId, lead.personId))
      .orderBy(desc(appointments.startsAt))
      .limit(1)
  )[0];

  const variables = await resolveVariables(lead.personId, appointment?.id ?? null);
  variables["link.unsubscribe"] = "https://example.invalid/unsubscribe/preview";

  const templateRows = await tx.select().from(messageTemplates).where(isNull(messageTemplates.archivedAt));
  const templates = new Map(templateRows.map((t) => [t.key, t]));

  const lines: TestRunLine[] = [];
  for (const [index, step] of rule.steps.entries()) {
    const base = { stepIndex: index, stepType: step.type, summary: describeStep(step) };

    if (step.type === "send_email" || step.type === "send_whatsapp") {
      const channel = step.type === "send_email" ? "email" : "whatsapp";
      const template = step.templateKey ? templates.get(step.templateKey) : undefined;
      const classification = template?.classification ?? step.purpose;
      let body = template?.body ?? step.body ?? "";
      if (!template && channel === "email" && step.purpose === "promotional" && !body.includes("link.unsubscribe")) {
        body += PROMOTIONAL_EMAIL_FOOTER;
      }
      const subject = template?.subject ?? (step.type === "send_email" ? step.subject : null) ?? null;

      const decision = await evaluateSend({
        clinicId: context.clinicId!,
        personId: lead.personId,
        leadId: lead.id,
        channel,
        classification,
        templateId: template?.id ?? null,
        whatsappTemplateName: template?.whatsappTemplateName ?? null,
        destination: await resolveDestination(lead.personId, channel),
        idempotencyKey: `dry-run:${randomUUID()}`,
      });
      const rendered = renderTemplate(body, variables);
      lines.push({
        ...base,
        outcome: decision.allowed ? "would_run" : "would_block",
        detail: decision.allowed
          ? rendered.missing.length
            ? `Missing for this lead: ${rendered.missing.join(", ")}`
            : null
          : decision.detail,
        preview: { subject: subject ? renderTemplate(subject, variables).text : null, body: rendered.text },
      });
      continue;
    }

    lines.push({
      ...base,
      outcome: step.type === "wait" || step.type === "filter" ? "info" : "would_run",
      // A condition depends on what has happened by the time the run gets
      // there, so it is checked then — not predicted now.
      detail: step.type === "filter" ? "Checked when the run reaches this step" : null,
      preview: null,
    });
  }

  return { lead: { id: lead.id, personName: person?.name ?? "Unknown" }, lines };
}
