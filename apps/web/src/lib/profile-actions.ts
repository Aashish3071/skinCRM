"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import type { ClinicProfile } from "@skincrm/contracts";
import { ApiError, SESSION_COOKIE, apiFetch } from "./api";

export type ProfileResult = { ok: true; detail?: string } | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

async function run(work: () => Promise<string | void>, paths: string[]): Promise<ProfileResult> {
  try {
    const detail = (await work()) ?? undefined;
    for (const p of paths) revalidatePath(p, "layout");
    return { ok: true, detail };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message, fieldErrors: error.details };
    return { ok: false, message: "Could not reach the server. Try again." };
  }
}

export async function saveClinicAction(input: ClinicProfile): Promise<ProfileResult> {
  return run(async () => { await apiFetch("/settings/clinic", { method: "PATCH", body: input }); return "Saved."; }, ["/"]);
}

export async function uploadLogoAction(dataUrl: string): Promise<ProfileResult> {
  return run(async () => { await apiFetch("/settings/clinic/logo", { method: "PUT", body: { dataUrl } }); return "Logo updated."; }, ["/"]);
}

export async function removeLogoAction(): Promise<ProfileResult> {
  return run(async () => { await apiFetch("/settings/clinic/logo", { method: "DELETE" }); return "Logo removed."; }, ["/"]);
}

export async function saveMyNameAction(fullName: string): Promise<ProfileResult> {
  return run(async () => { await apiFetch("/me", { method: "PATCH", body: { fullName } }); return "Saved."; }, ["/"]);
}

/** Changing the password signs every device out, including this one. */
export async function changePasswordAction(currentPassword: string, newPassword: string): Promise<ProfileResult> {
  try {
    await apiFetch("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
  } catch (error) {
    return error instanceof ApiError
      ? { ok: false, message: error.message, fieldErrors: error.details }
      : { ok: false, message: "Could not reach the server. Try again." };
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login?changed=1");
}

export async function startMfaAction(): Promise<{ ok: true; secret: string; qr: string } | { ok: false; message: string }> {
  try {
    const r = await apiFetch<{ secret: string; otpauthUrl: string }>("/auth/mfa/enroll", { method: "POST" });
    const qr = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 });
    return { ok: true, secret: r.secret, qr };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not start set-up." };
  }
}

export async function confirmMfaAction(totpCode: string): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; message: string }> {
  try {
    const r = await apiFetch<{ recoveryCodes: string[] }>("/auth/mfa/confirm", { method: "POST", body: { totpCode } });
    revalidatePath("/settings/profile");
    return { ok: true, recoveryCodes: r.recoveryCodes };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "That code didn't work." };
  }
}

export async function disableMfaAction(currentPassword: string): Promise<ProfileResult> {
  return run(async () => { await apiFetch("/auth/mfa/disable", { method: "POST", body: { currentPassword } }); return "Two-step sign-in is off."; }, ["/settings/profile"]);
}
