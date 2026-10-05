"use server";
import { revalidatePath } from "next/cache";
import { ApiError, apiFetch } from "./api";
export async function resolveDeliveryAction(
  id: string,
  body:
    | { outcome: "accepted"; providerMessageId: string; reason: string }
    | { outcome: "not_sent"; reason: string },
) {
  try {
    await apiFetch(`/messages/delivery-review/${id}`, { method: "POST", body });
    revalidatePath("/automations/messages");
    revalidatePath("/inbox");
    return { ok: true as const };
  } catch (e) {
    return {
      ok: false as const,
      message:
        e instanceof ApiError ? e.message : "Could not save delivery outcome.",
    };
  }
}
