import "server-only";
import { redirect } from "next/navigation";
import type { Capability, SessionUser } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

/**
 * Read the signed-in user, or null. Safe to call from any server component;
 * Next dedupes the fetch within a single render pass.
 */
export async function getSession(): Promise<SessionUser | null> {
  try {
    return await apiFetch<SessionUser>("/auth/session");
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthenticated) return null;
    throw error;
  }
}

/** Require a session, or send the visitor to sign in. */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Require a capability.
 *
 * This is a UX guard, not the security boundary — the API enforces the same
 * capability independently (see ARCHITECTURE.md section 8a). Its job is to show a
 * clear message instead of letting the page render and then fail on fetch.
 */
export async function requireCapability(capability: Capability): Promise<SessionUser> {
  const session = await requireSession();
  if (!session.capabilities.includes(capability)) redirect("/no-access");
  return session;
}

export function can(session: SessionUser, capability: Capability): boolean {
  return session.capabilities.includes(capability);
}
