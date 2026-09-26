import {
  FILTER_LABELS,
  LEAD_SOURCE_LABELS,
  STEP_LABELS,
  TRIGGER_LABELS,
  type AutomationStep,
  type AutomationStepType,
  type AutomationStopCondition,
  type AutomationTriggerConfig,
  type StageCategory,
} from "@skincrm/contracts";
import type { ComponentType } from "react";
import { ChatIcon, ClockIcon, FilterIcon, FlagIcon, MailIcon, TaskIcon } from "@/components/icons";

/** The draft the canvas edits. Same shape the API saves. */
export interface Draft {
  name: string;
  trigger: AutomationTriggerConfig;
  steps: AutomationStep[];
  stopWhen: AutomationStopCondition[];
}

export interface CanvasOptions {
  stages: { category: StageCategory; name: string }[];
  templates: {
    key: string;
    name: string;
    channel: "email" | "whatsapp";
    classification: "operational" | "promotional";
    whatsappTemplateName: string | null;
    whatsappStatus: string | null;
  }[];
  variables: { name: string; description: string }[];
}

export const STEP_ICONS: Record<AutomationStepType, ComponentType<{ size?: number }>> = {
  wait: ClockIcon,
  send_email: MailIcon,
  send_whatsapp: ChatIcon,
  create_task: TaskIcon,
  move_stage: FlagIcon,
  filter: FilterIcon,
};

/** Order in the "add a step" menu: the common ones first. */
export const STEP_MENU: AutomationStepType[] = ["send_email", "send_whatsapp", "wait", "create_task", "filter", "move_stage"];

export function newStepId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultStep(type: AutomationStepType, stages: CanvasOptions["stages"]): AutomationStep {
  const id = newStepId();
  switch (type) {
    case "wait":
      return { id, type, amount: 1, unit: "days" };
    case "send_email":
      return { id, type, templateKey: null, subject: "", body: "Hi {{person.firstName}},\n\n", purpose: "operational" };
    case "send_whatsapp":
      return { id, type, templateKey: null, body: "Hi {{person.firstName}}, ", purpose: "operational" };
    case "create_task":
      return { id, type, title: "Follow up", dueInHours: 0, priority: "normal" };
    case "move_stage":
      return { id, type, stageCategory: stages.find((s) => s.category !== "new")?.category ?? "connected" };
    case "filter":
      return { id, type, condition: "not_booked", stageCategories: [], sources: [] };
  }
}

export function stageName(category: StageCategory, stages: CanvasOptions["stages"]): string {
  return stages.find((s) => s.category === category)?.name ?? category.replace(/_/g, " ");
}

export function triggerSummary(trigger: AutomationTriggerConfig, stages: CanvasOptions["stages"]): string {
  switch (trigger.type) {
    case "lead_created":
      return trigger.sources.length === 0
        ? "From any source"
        : `From ${trigger.sources.map((s) => LEAD_SOURCE_LABELS[s]).join(", ")}`;
    case "stage_changed":
      return `Moved to ${stageName(trigger.stageCategory, stages)}`;
    case "appointment_upcoming":
      return trigger.hoursBefore % 24 === 0
        ? `${trigger.hoursBefore / 24} ${trigger.hoursBefore === 24 ? "day" : "days"} before it starts`
        : `${trigger.hoursBefore} ${trigger.hoursBefore === 1 ? "hour" : "hours"} before it starts`;
    default:
      return TRIGGER_LABELS[trigger.type].description;
  }
}

export function stepSummary(step: AutomationStep, options: CanvasOptions): string {
  const template = "templateKey" in step && step.templateKey ? options.templates.find((t) => t.key === step.templateKey) : null;
  switch (step.type) {
    case "wait":
      return `${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, "") : step.unit}`;
    case "send_email":
      return template ? `Template: ${template.name}` : step.subject?.trim() || "No subject yet";
    case "send_whatsapp":
      return template ? `Template: ${template.name}` : truncate(step.body ?? "", 60) || "No message yet";
    case "create_task":
      return `${step.title} · ${dueLabel(step.dueInHours)}`;
    case "move_stage":
      return `To ${stageName(step.stageCategory, options.stages)}`;
    case "filter":
      if (step.condition === "stage_is" && step.stageCategories.length) {
        return `Lead is ${step.stageCategories.map((c) => stageName(c, options.stages)).join(" or ")}`;
      }
      if (step.condition === "source_is" && step.sources.length) {
        return `Came from ${step.sources.map((s) => LEAD_SOURCE_LABELS[s]).join(" or ")}`;
      }
      return FILTER_LABELS[step.condition];
  }
}

export function stepTitle(step: AutomationStep): string {
  return STEP_LABELS[step.type].title;
}

export const DUE_PRESETS = [
  { hours: 0, label: "Right away" },
  { hours: 1, label: "In 1 hour" },
  { hours: 4, label: "In 4 hours" },
  { hours: 24, label: "Tomorrow" },
  { hours: 72, label: "In 3 days" },
];

export function dueLabel(hours: number): string {
  return DUE_PRESETS.find((p) => p.hours === hours)?.label.toLowerCase() ?? `due in ${hours}h`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Map validation paths ("steps.2.body", "trigger", "name") onto the canvas
 * node that owns them, so a problem shows on the card that needs fixing.
 */
export function errorsByNode(
  details: Record<string, string[]> | undefined,
  steps: AutomationStep[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!details) return out;
  for (const [path, messages] of Object.entries(details)) {
    const [head, index] = path.split(".");
    let node = "general";
    if (head === "trigger") node = "trigger";
    else if (head === "name") node = "name";
    else if (head === "stopWhen") node = "end";
    else if (head === "steps" && index !== undefined && steps[Number(index)]) node = steps[Number(index)]!.id;
    (out[node] ??= []).push(...messages);
  }
  return out;
}
