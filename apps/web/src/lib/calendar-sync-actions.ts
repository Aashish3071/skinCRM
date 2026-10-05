"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch } from "./api";

export type CalendarSyncResult = { ok: true; url?: string; detail?: string } | { ok: false; message: string };

async function run(work: () => Promise<{ url?: string; detail?: string } | void>): Promise<CalendarSyncResult> {
  try {
    const r = (await work()) ?? {};
    revalidatePath("/settings/profile");
    return { ok: true, ...r };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
}

export async function startCalendarSyncAction(provider: "google" | "microsoft") {
  return run(async () => ({ url: (await apiFetch<{ url: string }>(`/me/calendar-sync/${provider}/start`, { method: "POST" })).url }));
}

export async function syncCalendarNowAction() {
  return run(async () => {
    const r = await apiFetch<{ counts: { created: number; updated: number; deleted: number; busy: number } }>("/me/calendar-sync/sync", { method: "POST" });
    const c = r.counts;
    return { detail: `Synced: ${c.created} added, ${c.updated} updated, ${c.deleted} removed; ${c.busy} busy ${c.busy === 1 ? "time" : "times"} from your calendar.` };
  });
}

export async function disconnectCalendarAction() {
  return run(async () => { await apiFetch("/me/calendar-sync", { method: "DELETE" }); });
}
