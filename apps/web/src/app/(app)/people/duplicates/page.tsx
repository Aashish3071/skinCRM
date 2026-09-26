import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { getDuplicateGroups } from "@/lib/crm";
import { requireCapability } from "@/lib/session";
import { MergeGroup } from "./merge";

export const metadata = { title: "Duplicate review — SkinCRM" };

export default async function DuplicatesPage() {
  await requireCapability("people:merge");
  const groups = await getDuplicateGroups();

  return (
    <>
      <PageHeader
        title="Duplicate review"
        description="Records sharing a phone number or email. Nothing is merged automatically — a person decides, and a merge can be undone."
        actions={
          <Link href="/people" className="text-sm text-brand">
            Back to people
          </Link>
        }
      />

      {groups.length === 0 ? (
        <Card>
          <EmptyState title="No duplicates found">
            Every person has a distinct phone number and email address.
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group, index) => (
            <MergeGroup key={index} matchedOn={group.matchedOn} people={group.people} />
          ))}
        </div>
      )}
    </>
  );
}
