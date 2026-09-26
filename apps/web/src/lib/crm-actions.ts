"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "./api";

export type ActionState =
  | { status: "idle" }
  | { status: "success"; message?: string }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

/** Surface the API's own wording: it is the authority on why something failed. */
function toError(error: unknown): ActionState {
  if (error instanceof ApiError) {
    return { status: "error", message: error.message, fieldErrors: error.details };
  }
  return { status: "error", message: "Could not reach the server. Try again." };
}

const text = (form: FormData, key: string): string | undefined => {
  const value = form.get(key);
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
};

// --- Leads ----------------------------------------------------------------

export async function createLeadAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const payload = {
    person: {
      firstName: text(form, "firstName"),
      lastName: text(form, "lastName"),
      phone: text(form, "phone"),
      email: text(form, "email"),
      // Set by the confirmation step after the duplicate warning is shown.
      allowDuplicate: form.get("allowDuplicate") === "true",
    },
    source: text(form, "source") ?? "walk_in",
    serviceInterest: text(form, "serviceInterest"),
    inquiryNote: text(form, "inquiryNote"),
  };

  let leadId: string;
  try {
    const lead = await apiFetch<{ id: string }>("/leads", { method: "POST", body: payload });
    leadId = lead.id;
  } catch (error) {
    if (error instanceof ApiError && error.code === "duplicate_person") {
      // Do not create silently. Tell the user who already exists and let them
      // choose (PRD ID-06).
      return {
        status: "error",
        message: `${error.message} Tick "this is a different person" to continue anyway.`,
      };
    }
    return toError(error);
  }

  revalidatePath("/leads");
  redirect(`/leads/${leadId}`);
}

export async function changeStageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const leadId = String(form.get("leadId"));
  try {
    await apiFetch(`/leads/${leadId}/stage`, {
      method: "POST",
      body: { stageId: form.get("stageId"), reason: text(form, "reason") },
    });
  } catch (error) {
    return toError(error);
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  return { status: "success", message: "Stage updated." };
}

export async function assignLeadAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const leadId = String(form.get("leadId"));
  const ownerUserId = text(form, "ownerUserId") ?? null;
  try {
    await apiFetch(`/leads/${leadId}/assign`, { method: "POST", body: { ownerUserId } });
  } catch (error) {
    return toError(error);
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  return { status: "success", message: ownerUserId ? "Assigned." : "Returned to the queue." };
}

export async function logContactAttemptAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const leadId = String(form.get("leadId"));
  try {
    await apiFetch(`/leads/${leadId}/contact-attempts`, {
      method: "POST",
      body: {
        outcome: form.get("outcome"),
        channel: form.get("channel") ?? "phone",
        note: text(form, "note"),
      },
    });
  } catch (error) {
    return toError(error);
  }
  revalidatePath(`/leads/${leadId}`);
  return { status: "success", message: "Contact attempt logged." };
}

export async function addLeadNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const leadId = String(form.get("leadId"));
  try {
    await apiFetch(`/leads/${leadId}/notes`, { method: "POST", body: { body: form.get("body") } });
  } catch (error) {
    return toError(error);
  }
  revalidatePath(`/leads/${leadId}`);
  return { status: "success", message: "Note added to this inquiry." };
}

// --- Tasks ----------------------------------------------------------------

export async function createTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const leadId = text(form, "leadId");
  try {
    await apiFetch("/tasks", {
      method: "POST",
      body: {
        title: form.get("title"),
        detail: text(form, "detail"),
        leadId,
        dueAt: new Date(String(form.get("dueAt"))).toISOString(),
        priority: form.get("priority") ?? "normal",
      },
    });
  } catch (error) {
    return toError(error);
  }
  if (leadId) revalidatePath(`/leads/${leadId}`);
  revalidatePath("/home");
  return { status: "success", message: "Task created." };
}

export async function completeTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const taskId = String(form.get("taskId"));
  try {
    await apiFetch(`/tasks/${taskId}/complete`, {
      method: "POST",
      body: { outcome: form.get("outcome"), outcomeNote: text(form, "outcomeNote") },
    });
  } catch (error) {
    return toError(error);
  }
  revalidatePath("/home");
  const leadId = text(form, "leadId");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  return { status: "success", message: "Task completed." };
}

// --- People and notes -----------------------------------------------------

export async function addNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const personId = String(form.get("personId"));
  try {
    await apiFetch(`/people/${personId}/notes`, {
      method: "POST",
      body: { body: form.get("body"), pinned: form.get("pinned") === "on" },
    });
  } catch (error) {
    return toError(error);
  }
  revalidatePath(`/people/${personId}`);
  return { status: "success", message: "Note saved." };
}

export async function togglePinNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const noteId = String(form.get("noteId"));
  const personId = String(form.get("personId"));
  try {
    await apiFetch(`/notes/${noteId}`, {
      method: "PATCH",
      body: { pinned: form.get("pinned") === "true" },
    });
  } catch (error) {
    return toError(error);
  }
  revalidatePath(`/people/${personId}`);
  return { status: "success" };
}

export async function archiveNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const noteId = String(form.get("noteId"));
  const personId = String(form.get("personId"));
  try {
    await apiFetch(`/notes/${noteId}`, { method: "DELETE" });
  } catch (error) {
    return toError(error);
  }
  revalidatePath(`/people/${personId}`);
  return { status: "success", message: "Note archived." };
}

export async function mergePeopleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const survivingPersonId = String(form.get("survivingPersonId"));
  try {
    await apiFetch(`/people/${survivingPersonId}/merge`, {
      method: "POST",
      body: { mergedPersonId: form.get("mergedPersonId"), reason: text(form, "reason") },
    });
  } catch (error) {
    return toError(error);
  }
  revalidatePath("/people");
  revalidatePath("/people/duplicates");
  return { status: "success", message: "Records merged. This can be undone." };
}
