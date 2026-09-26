import { NotBuiltYet, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Leads — SkinCRM" };

export default async function LeadsPage() {
  await requireSession();
  return (
    <>
      <PageHeader title="Leads" />
      <NotBuiltYet
        phase="Phase 2"
        requirements={[
    "LEAD-01",
    "LEAD-02",
    "LEAD-03",
    "LEAD-04",
    "LEAD-05",
    "LEAD-06",
        ]}
        summary="Lead list and Kanban with search, filter and sort; configurable stages with history and required exit reasons; assignment rules and an unassigned queue; activity timeline; tasks."
      />
    </>
  );
}
