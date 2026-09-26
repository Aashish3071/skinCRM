import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { requireCapability } from "@/lib/session";
import { NewLeadForm } from "./form";

export const metadata = { title: "New inquiry — SkinCRM" };

export default async function NewLeadPage() {
  await requireCapability("leads:write");
  return (
    <>
      <PageHeader
        title="New inquiry"
        description="For a walk-in or a phone call. Only a name and one way to reach them are needed — the rest can wait."
        actions={
          <Link href="/leads" className="text-sm text-brand">
            Cancel
          </Link>
        }
      />
      <div className="max-w-2xl">
        <Card>
          <NewLeadForm />
        </Card>
      </div>
    </>
  );
}
