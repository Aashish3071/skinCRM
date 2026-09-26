"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { USER_ROLES, USER_ROLE_LABELS, type UserRole } from "@skincrm/contracts";
import { Badge, Card, Field, inputClasses } from "@/components/ui";
import {
  archiveStaffAction,
  inviteStaffAction,
  updateStaffRoleAction,
  type StaffActionState,
} from "./actions";

export interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: "invited" | "active" | "suspended";
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

const initial: StaffActionState = { status: "idle" };

export function InviteStaffForm() {
  const [state, action] = useActionState(inviteStaffAction, initial);

  return (
    <Card title="Invite a colleague" description="They set their own name and password from the link.">
      <form action={action} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Full name" htmlFor="fullName" errors={errorsFor(state, "fullName")}>
            <input id="fullName" name="fullName" required className={inputClasses} />
          </Field>
          <Field label="Email" htmlFor="email" errors={errorsFor(state, "email")}>
            <input id="email" name="email" type="email" required className={inputClasses} />
          </Field>
          <Field label="Role" htmlFor="role" errors={errorsFor(state, "role")}>
            <select id="role" name="role" defaultValue="front_desk" className={inputClasses}>
              {USER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {USER_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Message state={state} />

        <div>
          <SubmitButton label="Send invitation" pendingLabel="Inviting…" />
        </div>
      </form>
    </Card>
  );
}

export function StaffTable({ members, currentUserId }: { members: StaffMember[]; currentUserId: string }) {
  return (
    <Card title="Staff" description={`${members.length} ${members.length === 1 ? "account" : "accounts"}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Staff accounts at this clinic</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-subtle">
              <th scope="col" className="py-2 pr-4 font-medium">Name</th>
              <th scope="col" className="py-2 pr-4 font-medium">Role</th>
              <th scope="col" className="py-2 pr-4 font-medium">Status</th>
              <th scope="col" className="py-2 pr-4 font-medium">Two-factor</th>
              <th scope="col" className="py-2 pr-4 font-medium">Last sign-in</th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <StaffRow key={member.id} member={member} isSelf={member.id === currentUserId} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function StaffRow({ member, isSelf }: { member: StaffMember; isSelf: boolean }) {
  const [roleState, roleAction] = useActionState(updateStaffRoleAction, initial);
  const [archiveState, archiveAction] = useActionState(archiveStaffAction, initial);
  const feedback = roleState.status !== "idle" ? roleState : archiveState;

  return (
    <>
      <tr className="border-b border-line align-middle">
        <td className="py-3 pr-4">
          <div className="font-medium">
            {member.fullName}
            {isSelf && <span className="ml-1.5 text-xs text-ink-subtle">(you)</span>}
          </div>
          <div className="text-xs text-ink-muted">{member.email}</div>
        </td>

        <td className="py-3 pr-4">
          {isSelf ? (
            // The API refuses a self role change, so don't offer the control.
            <span className="text-ink-muted">{USER_ROLE_LABELS[member.role]}</span>
          ) : (
            <form action={roleAction} className="flex items-center gap-2">
              <input type="hidden" name="userId" value={member.id} />
              <label htmlFor={`role-${member.id}`} className="sr-only">
                Role for {member.fullName}
              </label>
              <select
                id={`role-${member.id}`}
                name="role"
                defaultValue={member.role}
                className="rounded-md border border-line-strong bg-surface px-2 py-1 text-sm"
              >
                {USER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {USER_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
              <SubmitButton label="Save" pendingLabel="…" subtle />
            </form>
          )}
        </td>

        <td className="py-3 pr-4">
          <Badge
            tone={
              member.status === "active" ? "positive" : member.status === "invited" ? "caution" : "neutral"
            }
          >
            {member.status === "invited"
              ? "Invitation pending"
              : member.status === "active"
                ? "Active"
                : "Suspended"}
          </Badge>
        </td>

        <td className="py-3 pr-4">
          {member.mfaEnabled ? (
            <Badge tone="positive">On</Badge>
          ) : (
            <Badge tone={member.role === "admin" ? "caution" : "neutral"}>Off</Badge>
          )}
        </td>

        <td className="py-3 pr-4 text-ink-muted">
          {member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString() : "Never"}
        </td>

        <td className="py-3">
          {!isSelf && member.status !== "suspended" && (
            <form action={archiveAction}>
              <input type="hidden" name="userId" value={member.id} />
              <SubmitButton label="Archive" pendingLabel="…" subtle danger />
            </form>
          )}
        </td>
      </tr>

      {feedback.status !== "idle" && (
        <tr>
          <td colSpan={6} className="pb-3">
            <Message state={feedback} />
          </td>
        </tr>
      )}
    </>
  );
}

function Message({ state }: { state: StaffActionState }) {
  if (state.status === "idle") return null;
  const isError = state.status === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`rounded-md px-3 py-2 text-sm ${
        isError
          ? "bg-critical-soft text-critical"
          : "bg-positive-soft text-positive"
      }`}
    >
      {state.message}
    </p>
  );
}

function SubmitButton({
  label,
  pendingLabel,
  subtle = false,
  danger = false,
}: {
  label: string;
  pendingLabel: string;
  subtle?: boolean;
  danger?: boolean;
}) {
  const { pending } = useFormStatus();
  const base = "rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60";
  const style = subtle
    ? danger
      ? "border border-line-strong text-critical hover:bg-critical-soft"
      : "border border-line-strong hover:bg-surface-muted"
    : "bg-brand text-white hover:bg-brand-hover";
  return (
    <button type="submit" disabled={pending} className={`${base} ${style}`}>
      {pending ? pendingLabel : label}
    </button>
  );
}

function errorsFor(state: StaffActionState, field: string): string[] | undefined {
  return state.status === "error" ? state.fieldErrors?.[field] : undefined;
}
