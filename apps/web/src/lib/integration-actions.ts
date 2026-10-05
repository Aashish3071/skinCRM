"use server";

import { revalidatePath } from "next/cache";
import type { WhatsAppSignupStart } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

export type Result = { ok: true; detail?: string; key?: string; url?: string } | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

async function run(work: () => Promise<{ detail?: string; key?: string; url?: string } | void>): Promise<Result> {
  try {
    const r = (await work()) ?? {};
    revalidatePath("/settings/integrations");
    revalidatePath("/settings/feedback");
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

/** "Connect with Facebook / Google": where to send the browser to sign in. */
export async function startOAuthAction(provider: "meta" | "google"): Promise<Result> {
  return run(async () => ({ url: (await apiFetch<{ url: string }>(`/integrations/oauth/${provider}/start`, { method: "POST" })).url }));
}

/** They picked a Page / ad account on the connect screen. */
export async function completeOAuthAction(pendingId: string, choiceId: string): Promise<Result> {
  return run(async () => {
    const r = await apiFetch<{ detail: string }>(`/integrations/oauth/pending/${encodeURIComponent(pendingId)}/complete`, { method: "POST", body: { choiceId } });
    return { detail: r.detail };
  });
}

export async function syncGoogleFormsAction(): Promise<Result> {
  return run(async () => ({ detail: (await apiFetch<{ detail: string }>("/integrations/google/sync-forms", { method: "POST" })).detail }));
}

/** WhatsApp Embedded Signup (D-88): what the browser needs to open Meta's popup. */
export async function startWhatsAppSignupAction(): Promise<{ ok: true; start: WhatsAppSignupStart } | { ok: false; message: string }> {
  try {
    return { ok: true, start: await apiFetch<WhatsAppSignupStart>("/integrations/whatsapp/signup/start", { method: "POST" }) };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
}

export async function completeWhatsAppSignupAction(input: { state: string; code: string; phoneNumberId: string; wabaId: string; coexistence: boolean }): Promise<Result> {
  return run(async () => ({ detail: (await apiFetch<{ detail: string }>("/integrations/whatsapp/signup/complete", { method: "POST", body: input })).detail }));
}

export async function checkConnectionAction(id: string): Promise<Result> {
  try {
    const r = await apiFetch<{ ok: boolean; detail: string }>(`/integrations/${id}/check`, { method: "POST" });
    revalidatePath("/settings/integrations");
    return r.ok ? { ok: true, detail: r.detail } : { ok: false, message: r.detail };
  } catch (error) { return { ok: false, message: error instanceof ApiError ? error.message : "Could not check the account." }; }
}
export async function retryInboundAction(id: string): Promise<Result> {
  return run(async () => { await apiFetch(`/integrations/events/${id}/retry`, { method: "POST" }); return { detail: "Queued for another attempt." }; });
}
