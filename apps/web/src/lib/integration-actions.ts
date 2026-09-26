"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch } from "./api";

export type Result = { ok: true; detail?: string; key?: string } | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

async function run(work: () => Promise<{ detail?: string; key?: string } | void>): Promise<Result> {
  try {
    const r = (await work()) ?? {};
    revalidatePath("/settings/integrations");
    return { ok: true, ...r };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message, fieldErrors: error.details };
    return { ok: false, message: "Could not reach the server. Try again." };
  }
}

export async function connectMetaAction(pageId: string, accessToken: string): Promise<Result> {
  return run(async () => { await apiFetch("/integrations/meta", { method: "PUT", body: { pageId, accessToken } }); });
}

export async function connectWhatsAppAction(input: { phoneNumberId: string; accessToken: string; displayPhone?: string; businessAccountId?: string }): Promise<Result> {
  return run(async () => { await apiFetch("/integrations/whatsapp", { method: "PUT", body: input }); });
}

export async function createGoogleKeyAction(): Promise<Result> {
  return run(async () => ({ key: (await apiFetch<{ key: string }>("/integrations/google/key", { method: "POST" })).key }));
}

export async function disconnectAction(id: string): Promise<Result> {
  return run(async () => { await apiFetch(`/integrations/${id}`, { method: "DELETE" }); });
}

export async function sendTestLeadAction(provider: "meta" | "google"): Promise<Result> {
  return run(async () => {
    await apiFetch(`/integrations/${provider}/test-lead`, { method: "POST" });
    // Don't make the admin wait for the worker's next tick.
    await apiFetch("/integrations/process-now", { method: "POST" });
    revalidatePath("/leads");
    return { detail: "A test lead was received. Find it at the top of New in Leads." };
  });
}

export async function testSendAction(channel: "email" | "whatsapp", to: string): Promise<Result> {
  try {
    const r = await apiFetch<{ ok: boolean; detail: string }>("/integrations/test-send", { method: "POST", body: { channel, to } });
    return r.ok ? { ok: true, detail: r.detail } : { ok: false, message: r.detail };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
}

export async function saveMessagingAction(input: { promotionalSendingApproved?: boolean; postalAddress?: string; sendingDomain?: string; supportEmail?: string }): Promise<Result> {
  return run(async () => { await apiFetch("/settings/messaging", { method: "PATCH", body: input }); });
}
