"use server";
import { apiFetch, ApiError } from "./api";
import { revalidatePath } from "next/cache";
export interface ImportPreview {
  headers: string[];
  mapping: Record<string, string>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  sample: {
    rowNumber: number;
    valid: boolean;
    errors: string[];
    values: Record<string, string | null>;
  }[];
  errors: { rowNumber: number; errors: string[] }[];
}
export async function previewImport(
  csv: string,
  mapping?: Record<string, string>,
) {
  try {
    return {
      ok: true as const,
      preview: await apiFetch<ImportPreview>("/imports/csv/preview", {
        method: "POST",
        body: { csv, mapping },
      }),
    };
  } catch (e) {
    return {
      ok: false as const,
      message:
        e instanceof ApiError ? e.message : "Could not preview this file.",
    };
  }
}
export async function commitImport(
  csv: string,
  mapping: Record<string, string>,
  skipInvalid: boolean,
) {
  try {
    const result = await apiFetch<{
      created: number;
      duplicates: number;
      failed: number;
      failures: { rowNumber: number; reason: string }[];
    }>("/imports/csv", { method: "POST", body: { csv, mapping, skipInvalid } });
    revalidatePath("/people");
    revalidatePath("/leads");
    return { ok: true as const, result };
  } catch (e) {
    return {
      ok: false as const,
      message:
        e instanceof ApiError
          ? e.message
          : "Import could not be confirmed. Preview and retry the same file; previously imported rows are deduplicated.",
    };
  }
}
