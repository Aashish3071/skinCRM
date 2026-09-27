import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  FILTER_LABELS,
  LEAD_SOURCE_LABELS,
  STEP_LABELS,
  type AutomationStep,
  type AutomationStopCondition,
  type AutomationTrigger,
  type AutomationTriggerConfig,
  type EnrollmentHistoryEntry,
  type LeadSource,
  type StageCategory,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { sendSystemEmail, webLink } from "../messaging/system-email";
import { getContext, getTx } from "../context";
import { logger } from "../logger";
import { addActivity, changeStage, getLead } from "../leads/service";
import { inQuietHours } from "../messaging/send-gate";
import { sendMessage, type SendOutcome } from "../messaging/service";

const {
  automationRules,
  automationEnrollments,
  appointments,
  clinics,
  leads,
  messages,
  pipelineStages,
  tasks,
  users,
  people,
} = schema;

/**
 * The automation engine (PRD MSG-03, MSG-06).
 *
 * Two halves:
 *
 *  - `emitAutomationEvent` runs inside whatever transaction caused the event
 *    (a lead created, an appointment booked) and enrolls the person in every
 *    active rule that matches. Same transaction, so a trigger is never lost
 *    and never fires for something that was rolled back.
 *
 *  - `runEnrollment` is called by the worker when a run is due. It walks the
 *    steps until it reaches a wait or the end, re-checking stop conditions
 *    before every step. Sends go through `sendMessage`, which runs the full
 *    send gate at that moment — consent, opt-outs, quiet hours and the rest
 *    are never checked at schedule time only (PRD 7).
 */

// --- Events ---------------------------------------------------------------

export type AutomationEvent =
  | { type: "lead_created"; leadId: string; personId: string; source: LeadSource }
  | { type: "stage_changed"; leadId: string; personId: string; stageCategory: StageCategory }
  | {
      type:
        | "appointment_booked"
        | "appointment_rescheduled"
        | "appointment_attended"
        | "appointment_no_show"
        | "appointment_canceled";
      appointmentId: string;
      personId: string;
      leadId: string | null;
      startsAt: Date;
    };

/** Which rule triggers an event can start. */
function triggerTypesFor(event: AutomationEvent): AutomationTrigger[] {
  switch (event.type) {
    case "appointment_booked":
      return ["appointment_booked", "appointment_upcoming"];
    // The replacement row of a moved appointment needs fresh reminders, not a
    // second confirmation. The caller stops the old row's runs.
    case "appointment_rescheduled":
      return ["appointment_upcoming"];
    default:
      return [event.type];
  }
}

function triggerMatches(trigger: AutomationTriggerConfig, event: AutomationEvent): boolean {
  if (trigger.type === "lead_created" && event.type === "lead_created") {
    return trigger.sources.length === 0 || trigger.sources.includes(event.source);
  }
  if (trigger.type === "stage_changed" && event.type === "stage_changed") {
    return trigger.stageCategory === event.stageCategory;
  }
  return true;
}

/** Earliest a reminder may still usefully go out before the appointment. */
const REMINDER_MIN_LEAD_MS = 30 * 60 * 1000;

/**
 * When a new run should start, or null when it should not start at all.
 *
 * Reminders are the only trigger that looks ahead. Booked with less notice
 * than the reminder asks for (a 24-hour reminder for something tomorrow
 * morning), the reminder goes out now rather than being skipped — unless the
 * appointment is so close a reminder would be noise.
 */
function startTimeFor(trigger: AutomationTriggerConfig, event: AutomationEvent, now: Date): Date | null {
  if (trigger.type !== "appointment_upcoming" || !("startsAt" in event)) return now;
  const due = new Date(event.startsAt.getTime() - trigger.hoursBefore * 60 * 60 * 1000);
  if (due > now) return due;
  return event.startsAt.getTime() - now.getTime() > REMINDER_MIN_LEAD_MS ? now : null;
}

/**
 * Enroll the person behind `event` in every active rule it matches.
 * Returns how many runs were started.
 */
export async function emitAutomationEvent(event: AutomationEvent, now = new Date()): Promise<number> {
  const context = getContext();
  const tx = getTx();

  // A cancelled or moved appointment's pending reminders and confirmations
  // must not go out (PRD CAL-05). Stop them before starting anything new.
  if (event.type === "appointment_canceled") {
    await stopRunsForAppointment(event.appointmentId, "The appointment was cancelled or moved");
  }

  const rules = await tx
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.status, "active"),
        inArray(automationRules.triggerType, triggerTypesFor(event)),
        sql`${automationRules.archivedAt} is null`,
      ),
    );

  let started = 0;
  for (const rule of rules) {
    if (!triggerMatches(rule.trigger, event)) continue;
    const startAt = startTimeFor(rule.trigger, event, now);
    if (!startAt) continue;

    const isAppointment = "appointmentId" in event;
    const inserted = await tx
      .insert(automationEnrollments)
      .values({
        clinicId: context.clinicId!,
        ruleId: rule.id,
        ruleVersion: rule.version,
        personId: event.personId,
        leadId: event.leadId,
        appointmentId: isAppointment ? event.appointmentId : null,
        // Once per lead for lead triggers, once per appointment otherwise, so
        // a replayed event — or two rules moving a lead back and forth — can
        // never enroll the same run twice.
        dedupeKey: isAppointment ? `appt:${event.appointmentId}` : `lead:${event.leadId}`,
        steps: rule.steps,
        stopWhen: rule.stopWhen,
        nextRunAt: startAt,
        startedAt: now,
      })
      .onConflictDoNothing({ target: [automationEnrollments.ruleId, automationEnrollments.dedupeKey] })
      .returning({ id: automationEnrollments.id });

    if (inserted.length > 0) started += 1;
  }

  if (started > 0) {
    logger.debug({ correlationId: context.correlationId, event: event.type, started }, "Automation runs started");
  }
  return started;
}

export async function stopRunsForAppointment(appointmentId: string, reason: string): Promise<void> {
  await getTx()
    .update(automationEnrollments)
    .set({ state: "stopped", stopReason: reason, finishedAt: new Date(), nextRunAt: null, updatedAt: new Date() })
    .where(and(eq(automationEnrollments.appointmentId, appointmentId), eq(automationEnrollments.state, "active")));
}

/** Pausing or archiving a rule stops everyone currently in it. */
export async function stopRunsForRule(ruleId: string, reason: string): Promise<number> {
  const stopped = await getTx()
    .update(automationEnrollments)
    .set({ state: "stopped", stopReason: reason, finishedAt: new Date(), nextRunAt: null, updatedAt: new Date() })
    .where(and(eq(automationEnrollments.ruleId, ruleId), eq(automationEnrollments.state, "active")))
    .returning({ id: automationEnrollments.id });
  return stopped.length;
}

// --- Running --------------------------------------------------------------

type Enrollment = typeof automationEnrollments.$inferSelect;

/** A provider failure is retried this many times before the run gives up. */
export const MAX_SEND_ATTEMPTS = 3;

export interface RunResult {
  state: Enrollment["state"];
  currentStep: number;
  nextRunAt: Date | null;
}

/**
 * Advance one run as far as it can go right now. Must be called inside the
 * run's clinic (see runAsSystem). Idempotent per step: sends use a key of
 * run + step, so a crash and retry cannot send the same step twice.
 */
export async function runEnrollment(enrollmentId: string, now = new Date()): Promise<RunResult | null> {
  const tx = getTx();
  const rows = await tx.select().from(automationEnrollments).where(eq(automationEnrollments.id, enrollmentId)).limit(1);
  const run = rows[0];
  if (!run || run.state !== "active") return null;

  const history = [...run.history];
  let step = run.currentStep;
  let attempts = run.attempts;

  const record = (entry: Omit<EnrollmentHistoryEntry, "at" | "stepIndex" | "stepType">) => {
    history.push({
      stepIndex: step,
      stepType: run.steps[step]?.type ?? "end",
      at: now.toISOString(),
      ...entry,
    });
  };

  const save = async (values: Partial<Enrollment>): Promise<RunResult> => {
    const updated = await tx
      .update(automationEnrollments)
      .set({ history, currentStep: step, attempts, lockedUntil: null, updatedAt: new Date(), ...values })
      .where(eq(automationEnrollments.id, run.id))
      .returning();
    const row = updated[0]!;
    return { state: row.state, currentStep: row.currentStep, nextRunAt: row.nextRunAt };
  };

  const finish = (state: "completed" | "stopped" | "failed", stopReason: string | null) =>
    save({ state, stopReason, finishedAt: now, nextRunAt: null });

  while (step < run.steps.length) {
    const stopReason = await stopConditionMet(run, now);
    if (stopReason) {
      record({ outcome: "stopped", detail: stopReason });
      return finish("stopped", stopReason);
    }

    const current = run.steps[step]!;

    switch (current.type) {
      case "wait": {
        const until = new Date(now.getTime() + waitMs(current.amount, current.unit));
        record({ outcome: "done", detail: `Waiting ${describeStep(current).replace(/^Wait /, "")}` });
        step += 1;
        return save({ nextRunAt: until });
      }

      case "filter": {
        const passed = await filterPasses(current, run);
        if (!passed) {
          const reason = `Condition not met: ${FILTER_LABELS[current.condition]}`;
          record({ outcome: "stopped", detail: reason });
          return finish("stopped", reason);
        }
        record({ outcome: "done", detail: FILTER_LABELS[current.condition] });
        break;
      }

      case "send_email":
      case "send_whatsapp": {
        // Quiet hours are waited out rather than recorded as a block: a
        // reminder due at 22:00 should arrive at 08:00, not never.
        const quietUntil = await quietHoursEnd(now);
        if (quietUntil) {
          return save({ nextRunAt: quietUntil });
        }

        const outcome = await sendStep(current, run, step, attempts);
        if (outcome.state === "failed" && outcome.retryable && attempts + 1 < MAX_SEND_ATTEMPTS) {
          attempts += 1;
          record({ outcome: "failed", detail: `${outcome.detail ?? "Send failed"}. Retrying.`, messageId: outcome.messageId || null });
          return save({ nextRunAt: new Date(now.getTime() + attempts * 5 * 60 * 1000), lastError: outcome.detail ?? null });
        }
        attempts = 0;
        record(sendHistory(outcome));
        break;
      }

      case "create_task": {
        const lead = run.leadId ? await getLead(run.leadId) : null;
        const inserted = await tx
          .insert(tasks)
          .values({
            clinicId: run.clinicId,
            leadId: run.leadId,
            personId: run.personId,
            title: current.title,
            // The lead's owner; unowned leads leave the task in the shared queue.
            ownerUserId: lead?.ownerUserId ?? null,
            dueAt: new Date(now.getTime() + current.dueInHours * 60 * 60 * 1000),
            priority: current.priority,
            createdByUserId: null,
          })
          .returning({ id: tasks.id });
        await addActivity({
          personId: run.personId,
          leadId: run.leadId,
          type: "task_created",
          summary: `Task created by automation: ${current.title}`,
          entityType: "task",
          entityId: inserted[0]!.id,
        });
        record({ outcome: "done", detail: current.title });
        break;
      }

      case "notify_team": {
        const sent = await notifyTeam(current, run);
        record({ outcome: sent > 0 ? "done" : "skipped", detail: sent > 0 ? `Emailed ${sent} ${sent === 1 ? "person" : "people"}` : "Nobody to email (no owner or addresses)" });
        break;
      }

      case "move_stage": {
        if (!run.leadId) {
          record({ outcome: "skipped", detail: "No lead to move" });
          break;
        }
        const target = await tx
          .select()
          .from(pipelineStages)
          .where(and(eq(pipelineStages.category, current.stageCategory), eq(pipelineStages.isActive, true)))
          .limit(1);
        if (!target[0]) {
          record({ outcome: "skipped", detail: "That stage is not in this clinic's pipeline" });
          break;
        }
        const target0 = target[0];
        // Lost needs a reason, which staff give; an automation supplies its own.
        await changeStage({
          leadId: run.leadId,
          stageId: target0.id,
          reason: target0.requiresReason ? "Moved by automation" : null,
        });
        record({ outcome: "done", detail: `Moved to ${target0.name}` });
        break;
      }
    }

    step += 1;
  }

  return finish("completed", null);
}

function waitMs(amount: number, unit: "minutes" | "hours" | "days"): number {
  const minute = 60 * 1000;
  return amount * (unit === "minutes" ? minute : unit === "hours" ? 60 * minute : 24 * 60 * minute);
}

function sendHistory(outcome: SendOutcome): Omit<EnrollmentHistoryEntry, "at" | "stepIndex" | "stepType"> {
  if (outcome.state === "sent") return { outcome: "done", detail: "Sent", messageId: outcome.messageId };
  if (outcome.state === "suppressed") {
    return {
      outcome: "blocked",
      detail: outcome.detail ?? outcome.suppressionReason ?? "Blocked by send safety",
      messageId: outcome.messageId || null,
    };
  }
  return { outcome: "failed", detail: outcome.detail ?? "Send failed", messageId: outcome.messageId || null };
}

/** Footer added to promotional email written on the canvas (CAN-SPAM). */
export const PROMOTIONAL_EMAIL_FOOTER =
  "\n\n—\n{{clinic.name}} · {{clinic.address}}\nUnsubscribe: {{link.unsubscribe}}";

async function sendStep(
  step: Extract<AutomationStep, { type: "send_email" | "send_whatsapp" }>,
  run: Enrollment,
  index: number,
  attempts: number,
): Promise<SendOutcome> {
  const channel = step.type === "send_email" ? "email" : "whatsapp";
  // Run + step: a retried job re-uses the key and the unique index refuses a
  // second copy. A provider rejection is retried under a fresh key, since by
  // definition nothing was delivered under the old one.
  const idempotencyKey = `auto:${run.id}:${index}${attempts > 0 ? `:retry${attempts}` : ""}`;

  if (step.templateKey) {
    return sendMessage({
      personId: run.personId,
      leadId: run.leadId,
      appointmentId: run.appointmentId,
      templateKey: step.templateKey,
      idempotencyKey,
      ruleId: run.ruleId,
    });
  }

  let body = step.body ?? "";
  if (channel === "email" && step.purpose === "promotional" && !body.includes("link.unsubscribe")) {
    body += PROMOTIONAL_EMAIL_FOOTER;
  }

  return sendMessage({
    personId: run.personId,
    leadId: run.leadId,
    appointmentId: run.appointmentId,
    adHoc: {
      channel,
      subject: step.type === "send_email" ? (step.subject ?? undefined) : undefined,
      body,
      classification: step.purpose,
    },
    idempotencyKey,
    ruleId: run.ruleId,
  });
}

/**
 * When quiet hours end, or null if it is not quiet hours now.
 *
 * Found by probing forward a minute at a time with the same `Intl` check that
 * decided it was quiet, so a DST change inside the window cannot make the two
 * disagree. If no end turns up within a day (a clinic has made every hour
 * quiet), it tries again tomorrow rather than sending anyway.
 */
async function quietHoursEnd(now: Date): Promise<Date | null> {
  const clinic = (
    await getTx()
      .select({ timezone: clinics.timezone, start: clinics.quietHoursStart, end: clinics.quietHoursEnd })
      .from(clinics)
      .limit(1)
  )[0];
  if (!clinic || !inQuietHours(now, clinic.timezone, clinic.start, clinic.end)) return null;

  const minute = 60 * 1000;
  let probe = new Date(Math.ceil((now.getTime() + 1) / minute) * minute);
  for (let i = 0; i < 24 * 60; i += 1) {
    if (!inQuietHours(probe, clinic.timezone, clinic.start, clinic.end)) return probe;
    probe = new Date(probe.getTime() + minute);
  }
  return new Date(now.getTime() + 24 * 60 * minute);
}

/**
 * The first reason this run should stop, or null (PRD MSG-06).
 *
 * Appointment-triggered runs also stop when their appointment is no longer in
 * the state that started them — a reminder for a cancelled appointment is the
 * classic automation bug, and this catches it even if the eager stop on
 * cancel was somehow missed.
 */
async function stopConditionMet(run: Enrollment, now: Date): Promise<string | null> {
  const tx = getTx();

  if (run.appointmentId) {
    const rule = (
      await tx.select({ triggerType: automationRules.triggerType }).from(automationRules)
        .where(eq(automationRules.id, run.ruleId)).limit(1)
    )[0];
    const appt = (
      await tx.select({ status: appointments.status, startsAt: appointments.startsAt }).from(appointments)
        .where(eq(appointments.id, run.appointmentId)).limit(1)
    )[0];
    if (!appt) return "The appointment no longer exists";
    const expected = expectedAppointmentStatuses(rule?.triggerType);
    if (expected && !expected.includes(appt.status)) {
      return `The appointment is now ${appt.status.replace(/_/g, " ")}`;
    }
    if (rule?.triggerType === "appointment_upcoming" && appt.startsAt <= now) {
      return "The appointment has already started";
    }
  }

  const conditions = new Set<AutomationStopCondition>(run.stopWhen);
  if (conditions.size === 0) return null;

  if (conditions.has("replied")) {
    const reply = await tx.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.personId, run.personId), eq(messages.direction, "inbound"), gt(messages.createdAt, run.startedAt)))
      .limit(1);
    if (reply[0]) return "They replied";
  }

  if (conditions.has("booked")) {
    const booked = await tx.select({ id: appointments.id }).from(appointments)
      .where(
        and(
          eq(appointments.personId, run.personId),
          gt(appointments.createdAt, run.startedAt),
          run.appointmentId ? ne(appointments.id, run.appointmentId) : undefined,
        ),
      )
      .limit(1);
    if (booked[0]) return "They booked an appointment";
  }

  if (run.leadId && (conditions.has("converted") || conditions.has("closed"))) {
    const lead = await getLead(run.leadId);
    if (conditions.has("converted") && lead.convertedAt) return "They became a client";
    if (conditions.has("closed") && lead.closedAt) return "The lead was closed";
  }

  return null;
}

function expectedAppointmentStatuses(trigger: AutomationTrigger | undefined): string[] | null {
  switch (trigger) {
    case "appointment_booked":
    case "appointment_upcoming":
      return ["scheduled", "confirmed"];
    case "appointment_attended":
      return ["attended"];
    case "appointment_no_show":
      return ["no_show"];
    case "appointment_canceled":
      return ["canceled"];
    default:
      return null;
  }
}

async function filterPasses(step: Extract<AutomationStep, { type: "filter" }>, run: Enrollment): Promise<boolean> {
  const tx = getTx();
  const lead = run.leadId ? await getLead(run.leadId) : null;

  switch (step.condition) {
    case "not_contacted":
      return !lead?.firstContactedAt;
    case "not_booked": {
      const booked = await tx.select({ id: appointments.id }).from(appointments)
        .where(and(eq(appointments.personId, run.personId), inArray(appointments.status, ["scheduled", "confirmed"]), isNotNull(appointments.startsAt)))
        .limit(1);
      return !booked[0];
    }
    case "stage_is": {
      if (!lead) return false;
      const stage = await tx.select({ category: pipelineStages.category }).from(pipelineStages)
        .where(eq(pipelineStages.id, lead.stageId)).limit(1);
      return stage[0] ? step.stageCategories.includes(stage[0].category) : false;
    }
    case "source_is":
      return lead ? step.sources.includes(lead.source) : false;
  }
}

/**
 * Email staff about this lead. Recipients are resolved at run time — whoever
 * owns the lead *now*, whoever is an admin *now* — and only active staff of
 * this clinic (RLS guarantees the clinic) plus addresses the admin typed in.
 *
 * The message carries the minimum needed to act: name, source, optionally
 * phone and email, the inquiry note's first line, and a link. Nothing from
 * General Notes (PRD ID-08).
 */
async function notifyTeam(step: Extract<AutomationStep, { type: "notify_team" }>, run: Enrollment): Promise<number> {
  const tx = getTx();
  const staff = await tx
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.status, "active"), isNull(users.archivedAt)));
  const lead = run.leadId ? await getLead(run.leadId) : null;

  const to = new Set<string>();
  for (const u of staff) {
    if (step.audiences.includes("everyone")) to.add(u.email);
    if (step.audiences.includes("admins") && u.role === "admin") to.add(u.email);
    if (step.audiences.includes("owner") && lead?.ownerUserId === u.id) to.add(u.email);
    if (step.userIds.includes(u.id)) to.add(u.email);
  }
  for (const e of step.extraEmails) to.add(e);
  if (to.size === 0) return 0;

  const person = (await tx.select().from(people).where(eq(people.id, run.personId)).limit(1))[0];
  const clinic = (await tx.select({ name: clinics.name }).from(clinics).limit(1))[0];
  const owner = lead?.ownerUserId ? staff.find((u) => u.id === lead.ownerUserId) : null;
  const ownerName = owner ? (await tx.select({ name: users.fullName }).from(users).where(eq(users.id, owner.id)).limit(1))[0]?.name : null;
  const name = person?.displayName ?? "Someone";
  const source = lead ? LEAD_SOURCE_LABELS[lead.source] : "an automation";
  const lines = [
    `New lead for ${clinic?.name ?? "your clinic"}: ${name}`,
    "",
    `Came from: ${source}`,
    ...(step.includeContact
      ? [person?.phoneRaw ? `Phone: ${person.phoneRaw}` : null, person?.emailRaw ? `Email: ${person.emailRaw}` : null].filter((l): l is string => Boolean(l))
      : []),
    `Owner: ${ownerName ?? "Unassigned — someone needs to pick it up"}`,
    ...(lead?.inquiryNote ? ["", `What they said: ${lead.inquiryNote.split("\n")[0]!.slice(0, 300)}`] : []),
    "",
    `Open the lead: ${webLink(lead ? `/leads/${lead.id}` : `/people/${run.personId}`)}`,
    "",
    "You get this email because an automation in SkinCRM is set up to send it.",
  ];

  let sent = 0;
  for (const address of to) {
    if (await sendSystemEmail({ to: address, subject: `New lead: ${name} (${source})`, text: lines.join("\n") })) sent += 1;
  }
  return sent;
}

/** Human summary of a step, for the dry run and the run history. */
export function describeStep(step: AutomationStep): string {
  switch (step.type) {
    case "wait":
      return `Wait ${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, "") : step.unit}`;
    case "filter":
      return `Only continue if: ${FILTER_LABELS[step.condition].toLowerCase()}`;
    case "create_task":
      return `Create task "${step.title}"`;
    case "move_stage":
      return `Move lead to ${step.stageCategory.replace(/_/g, " ")}`;
    case "notify_team":
      return "Email the team about this lead";
    default:
      return STEP_LABELS[step.type].title;
  }
}

/** The newest lead, used as the sample when a dry run names none. */
export async function latestLeadId(): Promise<string | null> {
  const rows = await getTx().select({ id: leads.id }).from(leads).orderBy(desc(leads.createdAt)).limit(1);
  return rows[0]?.id ?? null;
}
