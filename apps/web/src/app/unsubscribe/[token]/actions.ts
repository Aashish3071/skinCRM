"use server";

import { apiFetch } from "@/lib/api";

export async function unsubscribeAction(token: string): Promise<boolean> {
  try {
    await apiFetch(`/public/unsubscribe/${encodeURIComponent(token)}`, { method: "POST", anonymous: true });
    return true;
  } catch {
    return false;
  }
}
