"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { LoginResponse } from "@skincrm/contracts";
import { ApiError, SESSION_COOKIE, apiFetch } from "./api";

/**
 * Login state returned to the sign-in form. A discriminated union so the form can
 * render exactly one of: an error, the MFA challenge, or the clinic picker.
 */
export type LoginState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "mfa_required"; email: string; password: string }
  | { status: "choose_clinic"; email: string; password: string; clinics: { id: string; name: string }[] };

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const totpCode = str(formData.get("totpCode"));
  const recoveryCode = str(formData.get("recoveryCode"));
  const clinicId = str(formData.get("clinicId"));

  if (email === "" || password === "") {
    return { status: "error", message: "Enter your email and password." };
  }

  let setCookieHeader: string | null = null;
  let response: LoginResponse;

  try {
    response = await apiFetch<LoginResponse>("/auth/login", {
      method: "POST",
      anonymous: true,
      body: {
        email,
        password,
        ...(totpCode ? { totpCode } : {}),
        ...(recoveryCode ? { recoveryCode } : {}),
        ...(clinicId ? { clinicId } : {}),
      },
      onSetCookie: (value) => {
        setCookieHeader = value;
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { status: "error", message: error.message, fieldErrors: error.details };
    }
    // A network failure against the API is an operator problem, not the user's.
    return {
      status: "error",
      message: "Could not reach the server. Check that the API is running and try again.",
    };
  }

  if (response.result === "mfa_required") {
    // The password is carried in the form so the second step can resubmit it. It
    // never reaches the browser's URL or storage, and the whole exchange is one
    // Server Action round trip.
    return { status: "mfa_required", email, password };
  }

  if (response.result === "clinic_selection_required") {
    return { status: "choose_clinic", email, password, clinics: response.clinics };
  }

  if (!setCookieHeader) {
    return { status: "error", message: "Signed in, but no session was issued. Try again." };
  }

  await adoptSessionCookie(setCookieHeader);
  redirect("/home");
}

export async function logoutAction(): Promise<void> {
  try {
    await apiFetch<void>("/auth/logout", { method: "POST" });
  } catch {
    // Even if the API call fails, drop the local cookie so the user is signed out
    // from this browser's point of view.
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

/**
 * Re-issue the API's Set-Cookie on the web app's own response.
 *
 * The API and the web app are separate origins in development, so the cookie
 * arrives at the Next server and has to be set again for the browser. Its
 * attributes are re-derived here rather than parsed verbatim, because the value
 * is the only part we need and re-stating the flags keeps them explicit.
 */
async function adoptSessionCookie(setCookieHeader: string): Promise<void> {
  const firstPair = setCookieHeader.split(";")[0] ?? "";
  const separator = firstPair.indexOf("=");
  const name = firstPair.slice(0, separator).trim();
  const value = firstPair.slice(separator + 1).trim();

  if (name !== SESSION_COOKIE || value === "") {
    throw new Error("Unexpected session cookie from the API");
  }

  const maxAgeMatch = /max-age=(\d+)/i.exec(setCookieHeader);

  (await cookies()).set({
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeMatch ? Number(maxAgeMatch[1]) : 30 * 24 * 60 * 60,
  });
}

function str(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? undefined : text;
}
