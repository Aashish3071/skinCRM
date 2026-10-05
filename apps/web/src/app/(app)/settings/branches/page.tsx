import { apiFetch } from "@/lib/api";
import { requireCapability, can } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { Branches, type Branch } from "./client";
export default async function BranchesPage() {
  const session = await requireCapability("settings:read");
  const { items } = await apiFetch<{ items: Branch[] }>("/settings/branches");
  return (
    <>
      <PageHeader
        title="Branches"
        description="Manage clinic locations and choose the default branch."
      />
      <Branches items={items} writable={can(session, "settings:write")} />
    </>
  );
}
