"use server";

import { revalidatePath } from "next/cache";
import type { SavedViewDto } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

export type ViewResult = { ok: true; detail?: string; view?: SavedViewDto } | { ok: false; message: string };

async function run(work: () => Promise<{ detail?: string; view?: SavedViewDto } | void>): Promise<ViewResult> {
  try {
    const r = (await work()) ?? {};
    revalidatePath("/leads");
    return { ok: true, ...r };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server. Try again." };
  }
}

export async function saveViewAction(input: { name: string; query: Record<string, string>; shared: boolean }): Promise<ViewResult> {
  return run(async () => ({ view: await apiFetch<SavedViewDto>("/saved-views", { method: "POST", body: { screen: "leads", ...input } }) }));
}

export async function updateViewAction(id: string, input: { name?: string; query?: Record<string, string>; shared?: boolean }): Promise<ViewResult> {
  return run(async () => ({ view: await apiFetch<SavedViewDto>(`/saved-views/${id}`, { method: "PATCH", body: input }) }));
}

export async function deleteViewAction(id: string): Promise<ViewResult> {
  return run(async () => { await apiFetch(`/saved-views/${id}`, { method: "DELETE" }); });
}

export async function bulkAssignAction(leadIds: string[], ownerUserId: string | null): Promise<ViewResult> {
  return run(async () => {
    const r = await apiFetch<{ changed: number; unchanged: number; missing: number }>("/leads/bulk-assign", { method: "POST", body: { leadIds, ownerUserId } });
    const parts = [`${r.changed} ${r.changed === 1 ? "lead" : "leads"} reassigned`];
    if (r.unchanged) parts.push(`${r.unchanged} already had that owner`);
    if (r.missing) parts.push(`${r.missing} no longer exist`);
    return { detail: `${parts.join(", ")}.` };
  });
}
