"use server";
import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "./api";
async function change(
  url: string,
  method: "POST" | "PATCH" | "DELETE" | "PUT",
  body?: unknown,
) {
  try {
    await apiFetch(url, { method, body });
    revalidatePath("/settings/branches");
    revalidatePath("/settings/pipeline");
    revalidatePath("/leads");
    return { ok: true as const };
  } catch (e) {
    return {
      ok: false as const,
      message: e instanceof ApiError ? e.message : "Could not save. Try again.",
    };
  }
}
export async function saveBranch(
  id: string | null,
  body: {
    name: string;
    city: string | null;
    addressLine1: string | null;
    timezone: string | null;
    isDefault: boolean;
  },
) {
  return change(
    `/settings/branches${id ? `/${id}` : ""}`,
    id ? "PATCH" : "POST",
    body,
  );
}
export async function archiveBranch(id: string) {
  return change(`/settings/branches/${id}`, "DELETE");
}
export async function savePipeline(stages: { id: string; name: string }[]) {
  return change("/settings/pipeline", "PUT", { stages });
}
