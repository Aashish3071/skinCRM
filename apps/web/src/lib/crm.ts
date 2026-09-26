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

/** Tone for a stage badge, keyed by the stable category rather than the name. */
export function stageTone(category: StageCategory): "neutral" | "brand" | "positive" | "caution" | "critical" {
  switch (category) {
    case "converted":
      return "positive";
    case "consultation_booked":
    case "consultation_attended":
    case "qualified":
      return "brand";
    case "lost":
    case "unqualified":
    case "duplicate":
      return "critical";
    case "nurture":
      return "caution";
    default:
      return "neutral";
  }
}

/** "3 days ago" style, for timelines where the exact second rarely matters. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Absolute time in the clinic's timezone, for anything a clinic acts on. */
export function clinicTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}
