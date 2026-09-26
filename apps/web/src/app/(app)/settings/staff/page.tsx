import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { requireCapability } from "@/lib/session";
import { InviteStaffForm, StaffTable, type StaffMember } from "./staff-client";

export const metadata = { title: "Staff — SkinCRM" };

export default async function StaffSettingsPage() {
  const session = await requireCapability("users:read");
  const { items } = await apiFetch<{ items: StaffMember[] }>("/users");

  return (
    <>
      <PageHeader
        title="Staff and roles"
        description="Roles are enforced in the API and in database queries, not only here."
        actions={
          <Link href="/settings" className="text-sm text-brand">
            Back to settings
          </Link>
        }
      />

      <div className="flex flex-col gap-4">
        <StaffTable members={items} currentUserId={session.id} />
        <InviteStaffForm />
      </div>
    </>
  );
}
