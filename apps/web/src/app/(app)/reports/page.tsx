import { NotBuiltYet, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Reports — SkinCRM" };

export default async function ReportsPage() {
  await requireSession();
  return (
    <>
      <PageHeader title="Reports" />
      <NotBuiltYet
        phase="Phase 6"
        requirements={[
    "REP-01",
    "REP-02",
    "REP-03",
    "REP-04",
        ]}
        summary="Funnel with explicit denominators, source and campaign performance, an operations dashboard, and CSV export that respects filters and masks fields the role may not see."
      />
    </>
  );
}
