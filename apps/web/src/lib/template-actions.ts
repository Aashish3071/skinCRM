"use server";

import { revalidatePath } from "next/cache";
import type { CreateTemplate, TemplateDto } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

export type TemplateSaveResult =
  | { status: "saved"; template: TemplateDto }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

export async function saveTemplateAction(id: string | null, input: CreateTemplate): Promise<TemplateSaveResult> {
  try {
    const body = id ? (({ key: _key, ...rest }) => rest)(input) : input;
    const template = await apiFetch<TemplateDto>(id ? `/templates/${id}` : "/templates", {
      method: id ? "PATCH" : "POST",
      body,
    });
    revalidatePath("/automations/templates");
    return { status: "saved", template };
  } catch (error) {
    if (error instanceof ApiError) return { status: "error", message: error.message, fieldErrors: error.details };
    return { status: "error", message: "Could not reach the server. Try again." };
  }
}
