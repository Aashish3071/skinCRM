import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { requireCapability } from "@/lib/session";
import { NewLeadForm } from "./form";

export const metadata = { title: "Add lead — SkinCRM" };

export default async function NewLeadPage() {
  await requireCapability("leads:write");
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Add lead"
        description="For a walk-in or a phone call."
        actions={
          <Link href="/leads" className="text-sm text-ink-muted hover:text-ink">
            Cancel
          </Link>
        }
      />
      <Card>
        <NewLeadForm />
      </Card>
    </div>
  );
}
