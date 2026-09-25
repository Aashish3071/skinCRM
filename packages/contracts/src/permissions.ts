import type { UserRole } from "./enums";

/**
 * Capability-based RBAC (PRD 2). Routes declare the capability they need; the
 * API guard resolves the caller's role to a capability set. Adding a role means
 * filling one column here, not auditing every route.
 *
 * Capabilities are additionally narrowed at the data layer: `people:read` lets
 * a practitioner load a person, but the serializer still strips fields their
 * role may not see (see FIELD_VISIBILITY below).
 */
export const CAPABILITIES = [
  // People and notes
  "people:read",
  "people:write",
  "people:merge",
  "people:delete",
  "notes:read",
  "notes:write",
  "notes:archive",

  // Leads, tasks, activity
  "leads:read",
  "leads:read_all", // beyond own/assigned + unassigned queue
  "leads:write",
  "leads:assign",
  "leads:bulk_edit",
  "tasks:read",
  "tasks:write",

  // Calendar
  "appointments:read",
  "appointments:read_all", // other staff's calendars
  "appointments:write",

  // Messaging
  "conversations:read",
  "conversations:write",
  "conversations:assign",
  "messages:send",
  "templates:read",
  "templates:write",
  "automations:read",
  "automations:write",
  "consent:read",
  "consent:write",

  // Reporting
  "reports:read", // aggregate dashboards
  "reports:export",

  // Admin
  "users:read",
  "users:write",
  "settings:read",
  "settings:write",
  "integrations:read",
  "integrations:write",
  "feedback:read",
  "feedback:write",
  "audit:read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ADMIN_CAPABILITIES: readonly Capability[] = CAPABILITIES;

const FRONT_DESK_CAPABILITIES: readonly Capability[] = [
  "people:read",
  "people:write",
  "people:merge",
  "notes:read",
  "notes:write",
  "notes:archive",
  "leads:read",
  "leads:read_all",
  "leads:write",
  "leads:assign",
  "tasks:read",
  "tasks:write",
  "appointments:read",
  "appointments:read_all",
  "appointments:write",
  "conversations:read",
  "conversations:write",
  "conversations:assign",
  "messages:send",
  "templates:read",
  "consent:read",
  "consent:write",
  "reports:read",
];

const PRACTITIONER_CAPABILITIES: readonly Capability[] = [
  "people:read",
  "notes:read",
  "leads:read",
  "tasks:read",
  "tasks:write",
  "appointments:read",
  "appointments:write",
];

/**
 * Marketing analysts see aggregates only. They get no `people:read` and no
 * `leads:read`, so no route can hand them a personal record even by accident
 * (BRD 4: "without unrestricted access to personal details").
 */
const MARKETING_ANALYST_CAPABILITIES: readonly Capability[] = [
  "reports:read",
  "integrations:read",
  "feedback:read",
  "templates:read",
];

export const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  admin: ADMIN_CAPABILITIES,
  front_desk: FRONT_DESK_CAPABILITIES,
  practitioner: PRACTITIONER_CAPABILITIES,
  marketing_analyst: MARKETING_ANALYST_CAPABILITIES,
};

/** Pre-built sets so a capability check is O(1) on the request path. */
const CAPABILITY_SETS: Record<UserRole, ReadonlySet<Capability>> = {
  admin: new Set(ROLE_CAPABILITIES.admin),
  front_desk: new Set(ROLE_CAPABILITIES.front_desk),
  practitioner: new Set(ROLE_CAPABILITIES.practitioner),
  marketing_analyst: new Set(ROLE_CAPABILITIES.marketing_analyst),
};

export function roleHasCapability(role: UserRole, capability: Capability): boolean {
  return CAPABILITY_SETS[role].has(capability);
}

export function capabilitiesForRole(role: UserRole): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

/**
 * `reports:export` is admin-only by default but a clinic may grant it to front
 * desk (PRD 2: "limited export if admin enables it"). Stored per user as an
 * override rather than a new role.
 */
export const GRANTABLE_CAPABILITIES: readonly Capability[] = ["reports:export", "people:delete"];

/**
 * Fields the serializer removes for a role even when the row itself is
 * readable. Practitioners get the minimum needed for the visit; marketing
 * analysts should never reach a personal record at all, but the list is
 * defence in depth.
 */
export const FIELD_VISIBILITY: Record<UserRole, { deniedPersonFields: readonly string[] }> = {
  admin: { deniedPersonFields: [] },
  front_desk: { deniedPersonFields: [] },
  practitioner: {
    deniedPersonFields: ["email", "addressLine1", "addressLine2", "postalCode", "dateOfBirth"],
  },
  marketing_analyst: {
    deniedPersonFields: [
      "firstName",
      "lastName",
      "fullName",
      "email",
      "phone",
      "phoneE164",
      "addressLine1",
      "addressLine2",
      "postalCode",
      "dateOfBirth",
    ],
  },
};

/**
 * Lead visibility scope. `own` means assigned to the caller plus the unassigned
 * queue; enforced in the query builder, not only in the UI.
 */
export function leadVisibilityScope(role: UserRole): "all" | "own" | "none" {
  if (roleHasCapability(role, "leads:read_all")) return "all";
  if (roleHasCapability(role, "leads:read")) return "own";
  return "none";
}
