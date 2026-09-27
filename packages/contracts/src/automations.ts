import { z } from "zod";
import { isoDateTime, shortText, uuidSchema } from "./common";
import {
  AUTOMATION_STATUSES,
  AUTOMATION_STOP_CONDITIONS,
  ENROLLMENT_STATES,
  LEAD_SOURCES,
  STAGE_CATEGORIES,
  TASK_PRIORITIES,
  TEMPLATE_CLASSIFICATIONS,
  type AutomationStopCondition,
  type AutomationTrigger,
} from "./enums";

/**
 * Automations (PRD 4.4, MSG-03, MSG-06).
 *
 * An automation is one trigger followed by an ordered list of steps — the
 * Zapier shape, drawn top to bottom on the canvas. Deliberately linear: a
 * clinic needs "when X, wait, check, send", and branching trees are where
 * automation builders stop being usable by the front desk (D-58).
 *
 * The same schemas validate the canvas in the browser and the API on save,
 * so a rule that passes one cannot fail the other.
 */

// --- Trigger --------------------------------------------------------------

export const automationTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("lead_created"),
    /** Only leads from these sources. Empty means any source. */
    sources: z.array(z.enum(LEAD_SOURCES)).max(20).default([]),
  }),
  z.object({
    type: z.literal("stage_changed"),
    stageCategory: z.enum(STAGE_CATEGORIES),
  }),
  z.object({ type: z.literal("appointment_booked") }),
  z.object({
    type: z.literal("appointment_upcoming"),
    /** How long before the appointment the run starts. */
    hoursBefore: z.number().int().min(1).max(168),
  }),
  z.object({ type: z.literal("appointment_attended") }),
  z.object({ type: z.literal("appointment_no_show") }),
  z.object({ type: z.literal("appointment_canceled") }),
]);
export type AutomationTriggerConfig = z.infer<typeof automationTriggerSchema>;

export const TRIGGER_LABELS: Record<AutomationTrigger, { title: string; description: string }> = {
  lead_created: { title: "New lead comes in", description: "A new inquiry is created from any source." },
  stage_changed: { title: "Lead moves to a stage", description: "Someone moves the lead on the pipeline." },
  appointment_booked: { title: "Appointment is booked", description: "A new appointment is put in the calendar." },
  appointment_upcoming: { title: "Before an appointment", description: "A set number of hours before it starts." },
  appointment_attended: { title: "After a visit", description: "The appointment is marked as attended." },
  appointment_no_show: { title: "Missed appointment", description: "The appointment is marked as a no-show." },
  appointment_canceled: { title: "Appointment cancelled", description: "The appointment is cancelled." },
};

/** True when the trigger fires from an appointment rather than a lead. */
export function isAppointmentTrigger(type: AutomationTrigger): boolean {
  return type.startsWith("appointment_");
}

// --- Steps ----------------------------------------------------------------

/** Client-generated id so the canvas can key and reorder steps. */
const stepId = z.string().min(1).max(40);

export const WAIT_UNITS = ["minutes", "hours", "days"] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];

export const FILTER_CONDITIONS = ["not_contacted", "not_booked", "stage_is", "source_is"] as const;
export type FilterCondition = (typeof FILTER_CONDITIONS)[number];

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null || v.trim() === "" ? null : v));

const waitStep = z.object({
  id: stepId,
  type: z.literal("wait"),
  amount: z.number().int().min(1).max(365),
  unit: z.enum(WAIT_UNITS),
});

/**
 * A send uses either a saved template or text written on the canvas.
 *
 * `purpose` is required either way: whether a message is a service message
 * or marketing decides which consent applies, and it cannot be guessed from
 * the wording (PRD 4.4 US/Florida guardrail).
 */
const sendEmailStep = z.object({
  id: stepId,
  type: z.literal("send_email"),
  templateKey: optionalText(80),
  subject: optionalText(200),
  body: optionalText(20_000),
  purpose: z.enum(TEMPLATE_CLASSIFICATIONS),
});

const sendWhatsAppStep = z.object({
  id: stepId,
  type: z.literal("send_whatsapp"),
  templateKey: optionalText(80),
  body: optionalText(4_096),
  purpose: z.enum(TEMPLATE_CLASSIFICATIONS),
});

const createTaskStep = z.object({
  id: stepId,
  type: z.literal("create_task"),
  title: shortText(200),
  dueInHours: z.number().int().min(0).max(720),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
});

const moveStageStep = z.object({
  id: stepId,
  type: z.literal("move_stage"),
  stageCategory: z.enum(STAGE_CATEGORIES),
});

/**
 * Email staff about the lead (e.g. "a new lead came in") — for people away
 * from the desk. Internal mail, so no patient consent applies; it goes only
 * to active staff of this clinic and to addresses an admin typed in.
 */
export const NOTIFY_AUDIENCES = ["owner", "admins", "everyone"] as const;
export type NotifyAudience = (typeof NOTIFY_AUDIENCES)[number];

const notifyTeamStep = z.object({
  id: stepId,
  type: z.literal("notify_team"),
  audiences: z.array(z.enum(NOTIFY_AUDIENCES)).max(3).default(["owner"]),
  userIds: z.array(uuidSchema).max(50).default([]),
  extraEmails: z.array(z.string().trim().toLowerCase().email("Enter a valid email address")).max(20).default([]),
  /** Include phone and email in the message. Off sends only the name and a link. */
  includeContact: z.boolean().default(true),
});

/** "Only continue if…". A run that fails a filter ends quietly, as completed. */
const filterStep = z.object({
  id: stepId,
  type: z.literal("filter"),
  condition: z.enum(FILTER_CONDITIONS),
  stageCategories: z.array(z.enum(STAGE_CATEGORIES)).max(20).default([]),
  sources: z.array(z.enum(LEAD_SOURCES)).max(20).default([]),
});

export const automationStepSchema = z
  .discriminatedUnion("type", [
    waitStep,
    sendEmailStep,
    sendWhatsAppStep,
    createTaskStep,
    moveStageStep,
    filterStep,
    notifyTeamStep,
  ])
  .superRefine((step, ctx) => {
    if (step.type === "send_email" && !step.templateKey && !(step.subject && step.body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pick a saved template, or write a subject and a message",
        path: ["body"],
      });
    }
    if (step.type === "send_whatsapp" && !step.templateKey && !step.body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pick a saved template, or write a message",
        path: ["body"],
      });
    }
    if (step.type === "notify_team" && step.audiences.length === 0 && step.userIds.length === 0 && step.extraEmails.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose who should get the email", path: ["audiences"] });
    }
    if (step.type === "filter" && step.condition === "stage_is" && step.stageCategories.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick at least one stage", path: ["stageCategories"] });
    }
    if (step.type === "filter" && step.condition === "source_is" && step.sources.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick at least one source", path: ["sources"] });
    }
  });
export type AutomationStep = z.infer<typeof automationStepSchema>;
export type AutomationStepType = AutomationStep["type"];

export const STEP_LABELS: Record<AutomationStepType, { title: string; description: string }> = {
  wait: { title: "Wait", description: "Pause before the next step." },
  send_email: { title: "Send email", description: "Email the client." },
  send_whatsapp: { title: "Send WhatsApp", description: "Message the client on WhatsApp." },
  create_task: { title: "Create task", description: "Give the lead owner a to-do." },
  move_stage: { title: "Move lead", description: "Move the lead to another stage." },
  filter: { title: "Only continue if", description: "Stop here unless a condition is true." },
  notify_team: { title: "Email the team", description: "Tell staff by email — handy when they're away from the desk." },
};

export const NOTIFY_AUDIENCE_LABELS: Record<NotifyAudience, string> = {
  owner: "The lead's owner",
  admins: "All admins",
  everyone: "Everyone on the team",
};

export const FILTER_LABELS: Record<FilterCondition, string> = {
  not_contacted: "Nobody has contacted them yet",
  not_booked: "They have not booked an appointment",
  stage_is: "The lead is in one of these stages",
  source_is: "The lead came from one of these sources",
};

export const STOP_CONDITION_LABELS: Record<AutomationStopCondition, string> = {
  replied: "They reply",
  booked: "They book an appointment",
  converted: "They become a client",
  closed: "The lead is closed",
};

// --- Rule -----------------------------------------------------------------

const MAX_STEPS = 20;

export const saveAutomationSchema = z
  .object({
    name: shortText(120),
    trigger: automationTriggerSchema,
    steps: z.array(automationStepSchema).min(1, "Add at least one step").max(MAX_STEPS),
    stopWhen: z.array(z.enum(AUTOMATION_STOP_CONDITIONS)).max(AUTOMATION_STOP_CONDITIONS.length).default([]),
  })
  .superRefine((rule, ctx) => {
    if (rule.steps.every((step) => step.type === "wait" || step.type === "filter")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add a step that does something — a message, a task or a stage move",
        path: ["steps"],
      });
    }
    const ids = new Set<string>();
    for (const step of rule.steps) {
      if (ids.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step ids must be unique", path: ["steps"] });
      }
      ids.add(step.id);
    }
  });
export type SaveAutomation = z.infer<typeof saveAutomationSchema>;

export const setAutomationStatusSchema = z.object({
  status: z.enum(AUTOMATION_STATUSES),
});

export const testAutomationSchema = z.object({
  /** Run against this lead. Defaults to the most recent one. */
  leadId: uuidSchema.optional(),
});

export const automationSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: z.enum(AUTOMATION_STATUSES),
  trigger: automationTriggerSchema,
  steps: z.array(automationStepSchema),
  stopWhen: z.array(z.enum(AUTOMATION_STOP_CONDITIONS)),
  version: z.number().int(),
  activeCount: z.number().int(),
  completedCount: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AutomationDto = z.infer<typeof automationSchema>;

export const enrollmentHistoryEntrySchema = z.object({
  stepIndex: z.number().int(),
  stepType: z.string(),
  at: isoDateTime,
  outcome: z.enum(["done", "skipped", "blocked", "failed", "stopped"]),
  detail: z.string().nullable(),
  messageId: z.string().nullable().optional(),
});
export type EnrollmentHistoryEntry = z.infer<typeof enrollmentHistoryEntrySchema>;

export const enrollmentSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  personName: z.string(),
  leadId: uuidSchema.nullable(),
  appointmentId: uuidSchema.nullable(),
  state: z.enum(ENROLLMENT_STATES),
  currentStep: z.number().int(),
  nextRunAt: isoDateTime.nullable(),
  stopReason: z.string().nullable(),
  history: z.array(enrollmentHistoryEntrySchema),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});
export type EnrollmentDto = z.infer<typeof enrollmentSchema>;

/** One line of a dry run: what each step would do for a sample lead. */
export const testRunLineSchema = z.object({
  stepIndex: z.number().int(),
  stepType: z.string(),
  summary: z.string(),
  outcome: z.enum(["would_run", "would_block", "would_stop", "info"]),
  detail: z.string().nullable(),
  preview: z.object({ subject: z.string().nullable(), body: z.string() }).nullable(),
});
export type TestRunLine = z.infer<typeof testRunLineSchema>;

// --- Recipes --------------------------------------------------------------

/**
 * Starting points, from the PRD 4.4 initial rule templates (a)–(e). Opening a
 * recipe fills the canvas; nothing is saved until the admin presses Save, and
 * a new automation always starts paused.
 */
export const AUTOMATION_RECIPES: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  rule: SaveAutomation;
}> = [
  {
    key: "team_alert",
    name: "Email new leads to the team",
    description: "Every new lead — web, WhatsApp, Facebook or Google — is emailed to its owner and the admins, so nobody misses one while out.",
    rule: {
      name: "New lead alert by email",
      trigger: { type: "lead_created", sources: [] },
      stopWhen: [],
      steps: [
        { id: "s1", type: "notify_team", audiences: ["owner", "admins"], userIds: [], extraEmails: [], includeContact: true },
      ],
    },
  },
  {
    key: "acknowledge",
    name: "Thank new leads right away",
    description: "Email every new inquiry to say you got it and will be in touch.",
    rule: {
      name: "New inquiry thank-you",
      trigger: { type: "lead_created", sources: [] },
      stopWhen: ["closed"],
      steps: [
        {
          id: "s1",
          type: "send_email",
          templateKey: null,
          purpose: "operational",
          subject: "Thanks for contacting {{clinic.name}}",
          body: "Hi {{person.firstName}},\n\nThanks for getting in touch with {{clinic.name}}. One of our team will contact you shortly to find a time that suits you.\n\n{{clinic.name}}",
        },
      ],
    },
  },
  {
    key: "follow_up_task",
    name: "Remind staff to call new leads",
    description: "If nobody has contacted a new lead within 2 hours, create a call task.",
    rule: {
      name: "Call new leads within 2 hours",
      trigger: { type: "lead_created", sources: [] },
      stopWhen: ["booked", "closed"],
      steps: [
        { id: "s1", type: "wait", amount: 2, unit: "hours" },
        { id: "s2", type: "filter", condition: "not_contacted", stageCategories: [], sources: [] },
        { id: "s3", type: "create_task", title: "Call this new lead", dueInHours: 0, priority: "high" },
      ],
    },
  },
  {
    key: "confirmation",
    name: "Confirm new appointments",
    description: "Email the date and time as soon as an appointment is booked.",
    rule: {
      name: "Appointment confirmation",
      trigger: { type: "appointment_booked" },
      stopWhen: [],
      steps: [
        {
          id: "s1",
          type: "send_email",
          templateKey: null,
          purpose: "operational",
          subject: "Your appointment with {{clinic.name}}",
          body: "Hi {{person.firstName}},\n\nYou're booked in for {{appointment.date}} at {{appointment.time}} with {{appointment.staffName}}.\n\nOur address: {{clinic.address}}\n\nSee you then,\n{{clinic.name}}",
        },
      ],
    },
  },
  {
    key: "reminder",
    name: "Remind clients the day before",
    description: "Email a reminder 24 hours before each appointment.",
    rule: {
      name: "24-hour appointment reminder",
      trigger: { type: "appointment_upcoming", hoursBefore: 24 },
      stopWhen: [],
      steps: [
        {
          id: "s1",
          type: "send_email",
          templateKey: null,
          purpose: "operational",
          subject: "Reminder: your appointment with {{clinic.name}}",
          body: "Hi {{person.firstName}},\n\nA reminder of your appointment on {{appointment.date}} at {{appointment.time}} with {{appointment.staffName}}.\n\nIf you need to change it, just reply to this email.\n\n{{clinic.name}}",
        },
      ],
    },
  },
  {
    key: "no_show",
    name: "Follow up on missed appointments",
    description: "When someone misses an appointment, ask staff to call and rebook.",
    rule: {
      name: "No-show follow-up",
      trigger: { type: "appointment_no_show" },
      stopWhen: ["booked", "closed"],
      steps: [
        { id: "s1", type: "create_task", title: "Call to rebook the missed appointment", dueInHours: 4, priority: "high" },
      ],
    },
  },
];
