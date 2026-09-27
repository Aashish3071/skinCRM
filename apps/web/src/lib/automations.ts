import "server-only";
import type { AutomationDto, EnrollmentDto, StageCategory } from "@skincrm/contracts";
import { apiFetch } from "./api";

export interface AutomationOptions {
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
  staff: { id: string; name: string }[];
}

export const getAutomations = () =>
  apiFetch<{ items: AutomationDto[] }>("/automations").then((r) => r.items);

export const getAutomation = (id: string) => apiFetch<AutomationDto>(`/automations/${id}`);

export const getAutomationOptions = () => apiFetch<AutomationOptions>("/automations/options");

export const getAutomationRuns = (id: string) =>
  apiFetch<{ items: EnrollmentDto[] }>(`/automations/${id}/runs`).then((r) => r.items);
