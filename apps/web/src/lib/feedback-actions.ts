"use server";

import { revalidatePath } from "next/cache";
import type { FeedbackMapping, FeedbackPreview } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

export type FbResult = { ok: true; detail?: string } | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

async function run(work: () => Promise<string | void>): Promise<FbResult> {
  try {
    const detail = (await work()) ?? undefined;
    revalidatePath("/settings/feedback");
    return { ok: true, detail };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message, fieldErrors: error.details };
    return { ok: false, message: "Could not reach the server. Try again." };
  }
}

type Dest = "meta" | "google";

export async function saveMappingAction(d: Dest, mapping: FeedbackMapping, includeWhatsAppAds: boolean): Promise<FbResult> {
  return run(async () => { await apiFetch(`/feedback/${d}/settings`, { method: "PUT", body: { mapping, includeWhatsAppAds } }); return "Saved."; });
}
export async function connectFeedbackAction(d: Dest, body: Record<string, string>): Promise<FbResult> {
  return run(async () => { await apiFetch(`/feedback/${d}/credentials`, { method: "PUT", body }); return "Connected."; });
}
export async function revokeFeedbackAction(d: Dest): Promise<FbResult> {
  return run(async () => { await apiFetch(`/feedback/${d}/credentials`, { method: "DELETE" }); return "Disconnected and credentials deleted."; });
}
export async function confirmChecklistAction(d: Dest): Promise<FbResult> {
  return run(async () => {
    await apiFetch(`/feedback/${d}/checklist`, { method: "POST", body: { privacyApproved: true, policyChecked: true, dataUnderstood: true } });
    return "Ready for testing.";
  });
}
export async function markBlockedAction(d: Dest): Promise<FbResult> {
  return run(async () => { await apiFetch(`/feedback/${d}/blocked`, { method: "POST" }); return "Marked as not allowed. Nothing will be sent."; });
}
export async function testFeedbackAction(d: Dest): Promise<FbResult> {
  try {
    const r = await apiFetch<{ ok: boolean; detail: string }>(`/feedback/${d}/test`, { method: "POST" });
    revalidatePath("/settings/feedback");
    return r.ok ? { ok: true, detail: r.detail } : { ok: false, message: r.detail };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
}
export async function goLiveAction(d: Dest): Promise<FbResult> {
  return run(async () => { await apiFetch(`/feedback/${d}/go-live`, { method: "POST", body: { confirm: true } }); return "Live. Real events will now be sent."; });
}
export async function pauseFeedbackAction(d: Dest, paused: boolean): Promise<FbResult> {
  return run(async () => { await apiFetch(`/feedback/${d}/pause`, { method: "POST", body: { paused } }); return paused ? "Paused. Nothing will be sent." : "Resumed."; });
}
export async function previewFeedbackAction(d: Dest): Promise<{ ok: true; preview: FeedbackPreview & { basedOn: string } } | { ok: false; message: string }> {
  try {
    return { ok: true, preview: await apiFetch(`/feedback/${d}/preview`, { method: "POST", body: {} }) };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not load the preview." };
  }
}

export async function applyGoogleConnectionAction(): Promise<FbResult> {
  return run(async () => { await apiFetch("/feedback/google/credentials/from-connection", { method: "POST" }); });
}
