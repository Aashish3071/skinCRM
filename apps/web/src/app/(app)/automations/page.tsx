import { NotBuiltYet, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Automations — SkinCRM" };

export default async function AutomationsPage() {
  await requireSession();
  return (
    <>
      <PageHeader title="Automations" />
      <NotBuiltYet
        phase="Phase 4"
        requirements={[
    "MSG-01",
    "MSG-02",
    "MSG-03",
    "MSG-04",
    "MSG-05",
    "MSG-06",
    "MSG-07",
        ]}
        summary="Templates with approved variables and preview, trigger and action rules, the consent ledger, send safety with frequency caps and idempotency, stop conditions, and the delivery log."
      />
    </>
  );
}
