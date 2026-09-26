"use server";

import { revalidatePath } from "next/cache";
import { USER_ROLES, type UserRole } from "@skincrm/contracts";
import { ApiError, apiFetch } from "@/lib/api";

export type StaffActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

export async function inviteStaffAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!USER_ROLES.includes(role as UserRole)) {
    return { status: "error", message: "Choose a role." };
  }

  try {
    await apiFetch("/users", { method: "POST", body: { email, fullName, role, branchIds: [] } });
  } catch (error) {
    return toState(error);
  }

  revalidatePath("/settings/staff");
  return {
    status: "success",
    // Honest about the current state: the email connector arrives in phase 4, so
    // the invitation link is printed to the API console for now.
    message: `Invited ${fullName}. Until the email connector is connected, the invitation link is printed in the API server log.`,
  };
}

export async function updateStaffRoleAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");

  try {
    await apiFetch(`/users/${userId}`, { method: "PATCH", body: { role } });
  } catch (error) {
    return toState(error);
  }

  revalidatePath("/settings/staff");
  return { status: "success", message: "Role updated. That person's sessions were signed out." };
}

export async function archiveStaffAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  const userId = String(formData.get("userId") ?? "");

  try {
    await apiFetch(`/users/${userId}`, { method: "DELETE" });
  } catch (error) {
    return toState(error);
  }

  revalidatePath("/settings/staff");
  return {
    status: "success",
    message: "Account archived. Their history stays attributable and can be restored.",
  };
}

/**
 * Surface the API's own message and field errors. The API is the authority on
 * whether an action is allowed, so its wording is what the user should see rather
 * than a guess made here.
 */
function toState(error: unknown): StaffActionState {
  if (error instanceof ApiError) {
    return { status: "error", message: error.message, fieldErrors: error.details };
  }
  return { status: "error", message: "Could not reach the server. Try again." };
}
