"use server";

import type { ConversationDetail } from "@skincrm/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "./api";

export type InboxResult = { ok: true; message?: string } | { ok: false; message: string };

async function run(work: () => Promise<unknown>, id?: string): Promise<InboxResult> {
  try {
    await work();
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server. Try again." };
  }
  revalidatePath("/inbox");
  if (id) revalidatePath(`/inbox/${id}`);
  return { ok: true };
}

export async function replyAction(id: string, input: { body?: string; templateKey?: string; requestId: string }): Promise<InboxResult> {
  let state: string | undefined;
  let detail: string | undefined;
  const result = await run(async () => {
    const outcome = await apiFetch<{ state: string; detail?: string }>(`/conversations/${id}/reply`, { method: "POST", body: input });
    state = outcome.state;
    detail = outcome.detail;
  }, id);
  if (result.ok && state !== "sent") return { ok: false, message: detail ?? "The message was not sent." };
  return result;
}

export async function addConversationNoteAction(id: string, body: string): Promise<InboxResult> {
  return run(() => apiFetch(`/conversations/${id}/notes`, { method: "POST", body: { body } }), id);
}

export async function assignConversationAction(id: string, userId: string | null): Promise<InboxResult> {
  return run(() => apiFetch(`/conversations/${id}/assign`, { method: "POST", body: { userId } }), id);
}

export async function setConversationStatusAction(id: string, status: "open" | "resolved"): Promise<InboxResult> {
  return run(() => apiFetch(`/conversations/${id}/status`, { method: "POST", body: { status } }), id);
}

/** Called while typing, so colleagues see "… is replying". Never fails loudly. */
export async function typingAction(id: string): Promise<void> {
  await apiFetch(`/conversations/${id}/typing`, { method: "POST" }).catch(() => undefined);
}

export async function markReadAction(id: string): Promise<void> {
  await apiFetch(`/conversations/${id}/read`, { method: "POST" }).catch(() => undefined);
  revalidatePath("/inbox");
}

export async function simulateInboundAction(input: { phone: string; name?: string; body: string }): Promise<InboxResult & { conversationId?: string }> {
  try {
    const result = await apiFetch<{ conversationId: string }>("/inbox/simulate", { method: "POST", body: input });
    revalidatePath("/inbox");
    return { ok: true, conversationId: result.conversationId };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
}

/** "Message on WhatsApp" from a lead or profile: open (or create) their thread. */
export async function openConversationAction(personId: string): Promise<InboxResult> {
  let id: string;
  try {
    id = (await apiFetch<{ id: string }>("/conversations", { method: "POST", body: { personId } })).id;
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
  redirect(`/inbox/${id}`);
}

export async function olderConversationAction(id: string, cursor: { before: string; beforeId: string }) {
  return apiFetch<ConversationDetail>(`/conversations/${id}?${new URLSearchParams(cursor)}`);
}
export async function setConversationTagsAction(id: string, tags: string[]): Promise<InboxResult> {
 return run(() => apiFetch(`/conversations/${id}/tags`, { method: "PATCH", body: { tags } }), id);
}
