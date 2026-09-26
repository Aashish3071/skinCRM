"use server";

import { revalidatePath } from "next/cache";
import type { AutomationDto, AutomationStatus, SaveAutomation, TestRunLine } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

export type SaveResult =
  | { status: "saved"; automation: AutomationDto }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

function failure(error: unknown): { status: "error"; message: string; fieldErrors?: Record<string, string[]> } {
  if (error instanceof ApiError) return { status: "error", message: error.message, fieldErrors: error.details };
  return { status: "error", message: "Could not reach the server. Try again." };
}

export async function saveAutomationAction(id: string | null, rule: SaveAutomation): Promise<SaveResult> {
  try {
    const automation = await apiFetch<AutomationDto>(id ? `/automations/${id}` : "/automations", {
      method: id ? "PUT" : "POST",
      body: rule,
    });
    revalidatePath("/automations");
    return { status: "saved", automation };
  } catch (error) {
    return failure(error);
  }
}

export async function setAutomationStatusAction(
  id: string,
  status: AutomationStatus,
): Promise<{ status: "ok"; automation: AutomationDto } | { status: "error"; message: string }> {
  try {
    const automation = await apiFetch<AutomationDto>(`/automations/${id}/status`, { method: "POST", body: { status } });
    revalidatePath("/automations");
    revalidatePath(`/automations/${id}`);
    return { status: "ok", automation };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteAutomationAction(id: string): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  try {
    await apiFetch(`/automations/${id}`, { method: "DELETE" });
    revalidatePath("/automations");
    return { status: "ok" };
  } catch (error) {
    return failure(error);
  }
}

export type TestResult =
  | { status: "ok"; lead: { id: string; personName: string }; lines: TestRunLine[] }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

export async function testAutomationAction(rule: SaveAutomation): Promise<TestResult> {
  try {
    const result = await apiFetch<{ lead: { id: string; personName: string }; lines: TestRunLine[] }>("/automations/test", {
      method: "POST",
      body: rule,
    });
    return { status: "ok", ...result };
  } catch (error) {
    return failure(error);
  }
}
