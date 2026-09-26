import "server-only";
import type { LeadDto, NoteDto, PersonDto, StageCategory, TaskDto } from "@skincrm/contracts";
import { apiFetch } from "./api";

/**
 * Typed reads for the CRM screens. Thin on purpose: the API already returns the
 * shape the UI needs, so this layer only names the endpoints and the response
 * envelopes in one place.
 */

export interface PipelineStage {
  id: string;
  name: string;
  category: StageCategory;
  position: number;
  isClosed: boolean;
  requiresReason: boolean;
}

export interface LeadListResponse {
  items: LeadDto[];
  totalCount: number;
  stageCounts: Record<string, number>;
  viewerId: string | null;
}

export interface TimelineEntry {
  id: string;
  type: string;
  summary: string;
  body: string | null;
  outcome: string | null;
  actorLabel: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export const getStages = () =>
  apiFetch<{ items: PipelineStage[] }>("/pipeline/stages").then((r) => r.items);

export const getLeads = (query: string) => apiFetch<LeadListResponse>(`/leads?${query}`);

export const getLead = (id: string) => apiFetch<LeadDto>(`/leads/${id}`);

export const getLeadTimeline = (id: string) =>
  apiFetch<{ items: TimelineEntry[] }>(`/leads/${id}/timeline`).then((r) => r.items);

export const getLeadTasks = (id: string) =>
  apiFetch<{ items: TaskDto[] }>(`/leads/${id}/tasks`).then((r) => r.items);

export const getTasks = (query: string) =>
  apiFetch<{ items: TaskDto[] }>(`/tasks?${query}`).then((r) => r.items);

export const getPeople = (query: string) =>
  apiFetch<{ items: PersonDto[]; totalCount: number }>(`/people?${query}`);

export const getPerson = (id: string) => apiFetch<PersonDto>(`/people/${id}`);

export const getPersonNotes = (id: string) =>
  apiFetch<{ items: NoteDto[] }>(`/people/${id}/notes`).then((r) => r.items);

export const getPersonLeads = (id: string) =>
  apiFetch<{
    items: {
      id: string;
      source: string;
      stageId: string;
      ownerUserId: string | null;
      serviceInterest: string | null;
      createdAt: string;
      closedAt: string | null;
    }[];
  }>(`/people/${id}/leads`).then((r) => r.items);

export const getDuplicateGroups = () =>
  apiFetch<{ items: { matchedOn: string; people: PersonDto[] }[] }>("/people/duplicates").then(
    (r) => r.items,
  );

export const getStaff = () =>
  apiFetch<{ items: { id: string; fullName: string; email: string; role: string; status: string }[] }>(
    "/users",
  ).then((r) => r.items);

export const getAssignees = () =>
  apiFetch<{ items: { id: string; fullName: string }[] }>("/leads/assignees").then((r) => r.items);

// Formatting helpers live in ./format so client components can use them too;
// this module is server-only.
export { clinicTime, relativeTime, stageTone } from "./format";
