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

export async function syncWhatsAppTemplatesAction() {
  try {
    const catalogue = await apiFetch<{ items: { id: string; name: string; language: string; status: string; supported: boolean; components: { type: string; text?: string }[] }[]; variables: { key: string; label: string }[] }>("/templates/whatsapp/sync", { method: "POST" });
    revalidatePath("/automations/templates");
    return { ok: true as const, catalogue };
  } catch (error) { return { ok: false as const, message: error instanceof ApiError ? error.message : "Could not load WhatsApp templates." }; }
}
export async function importWhatsAppTemplateAction(id: string, variables: string[]) {
  try {
    await apiFetch("/templates/whatsapp/import", { method: "POST", body: { id, variables } });
    revalidatePath("/automations/templates");
    return { ok: true as const };
  } catch (error) { return { ok: false as const, message: error instanceof ApiError ? error.message : "Could not import this template." }; }
}
