"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch } from "./api";

export async function saveOnlineBookingAction(input: { enabled: boolean; cutoffHours: number; bookableTypeIds: string[] }): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await apiFetch("/settings/online-booking", { method: "PUT", body: input });
    revalidatePath("/settings/calendar");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
}
