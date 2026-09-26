"use server";

import { apiFetch } from "@/lib/api";

export type ResetState = { status: "idle" } | { status: "sent" } | { status: "error"; message: string };

export async function requestResetAction(_previous: ResetState, formData: FormData): Promise<ResetState> {
  const email = String(formData.get("email") ?? "").trim();
  if (email === "") return { status: "error", message: "Enter your email." };

  try {
    await apiFetch("/auth/password-reset", { method: "POST", anonymous: true, body: { email } });
  } catch {
    // The API answers identically whether or not the address exists, so the only
    // way this throws is a transport or rate-limit problem.
    return { status: "error", message: "Could not send the link just now. Try again in a few minutes." };
  }

  // Deliberately the same confirmation regardless of whether an account exists:
  // telling the user otherwise would make this an account-enumeration endpoint.
  return { status: "sent" };
}
