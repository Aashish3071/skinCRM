"use server";

import { ApiError, apiFetch } from "@/lib/api";

export type SetPasswordState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

/**
 * Finishes both token flows: a password reset, and accepting an invitation.
 * The token arrives in the emailed link and is posted back from a hidden field.
 */
export async function setPasswordAction(
  _previous: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const mode = String(formData.get("mode"));
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim();

  if (password !== confirm) {
    return { status: "error", message: "The two passwords don't match.", fieldErrors: { confirm: ["Doesn't match"] } };
  }

  try {
    if (mode === "invite") {
      await apiFetch("/auth/accept-invite", { method: "POST", anonymous: true, body: { token, fullName, password } });
    } else {
      await apiFetch("/auth/password-reset/confirm", { method: "POST", anonymous: true, body: { token, password } });
    }
    return { status: "done" };
  } catch (error) {
    if (error instanceof ApiError) {
      return { status: "error", message: error.message, fieldErrors: error.details };
    }
    return { status: "error", message: "Something went wrong. Try again in a moment." };
  }
}
