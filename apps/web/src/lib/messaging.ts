import "server-only";
import type { MessageDto, TemplateDto } from "@skincrm/contracts";
import { apiFetch } from "./api";

export const getTemplates = () => apiFetch<{ items: TemplateDto[] }>("/templates").then((r) => r.items);

export const getTemplateVariables = () =>
  apiFetch<{ items: { name: string; description: string }[] }>("/templates/variables").then((r) => r.items);

export const getMessages = (query: string) =>
  apiFetch<{ items: MessageDto[]; totalCount: number }>(`/messages?${query}`);
