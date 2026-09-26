import { FIELD_VISIBILITY, type UserRole } from "@skincrm/contracts";
import { getContext } from "./context";

/**
 * Strip fields the caller's role may not see, even on a row they are allowed to
 * read (PRD 2: a practitioner gets "the minimum needed contact/appointment
 * information").
 *
 * This is the last of three layers, not the only one:
 *   1. the capability check decides whether the route runs at all,
 *   2. row-level security decides which rows exist for this clinic,
 *   3. this decides which fields of those rows are returned.
 *
 * Denied fields are replaced with null rather than removed, so the response
 * shape stays stable and the client does not have to branch on role to parse it.
 */
export function maskPersonFields<T extends Record<string, unknown>>(
  value: T,
  role: UserRole = requireRole(),
): T {
  const denied = FIELD_VISIBILITY[role].deniedPersonFields;
  if (denied.length === 0) return value;

  const masked = { ...value } as Record<string, unknown>;
  for (const field of denied) {
    if (field in masked) masked[field] = null;
  }
  return masked as T;
}

export function maskPeopleFields<T extends Record<string, unknown>>(
  values: T[],
  role: UserRole = requireRole(),
): T[] {
  return values.map((value) => maskPersonFields(value, role));
}

function requireRole(): UserRole {
  const { role } = getContext();
  if (!role) {
    // Reaching here means a person record is being serialized outside an
    // authenticated request. Fail loudly rather than guessing a permissive role.
    throw new Error("Cannot mask person fields without a role on the request context");
  }
  return role;
}
