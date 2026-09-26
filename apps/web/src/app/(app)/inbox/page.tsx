import { NotBuiltYet, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Inbox — SkinCRM" };

export default async function InboxPage() {
  await requireSession();
  return (
    <>
      <PageHeader title="Inbox" />
      <NotBuiltYet
        phase="Phase 5"
        requirements={[
    "WA-01",
    "WA-02",
    "WA-03",
    "WA-04",
    "WA-05",
    "WA-06",
    "WA-07",
        ]}
        summary="Shared WhatsApp inbox: unassigned, mine and all views, assignment so two staff cannot unknowingly reply to the same conversation, internal notes, and reply from the CRM within the 24-hour service window or with an approved template."
      />
    </>
  );
}
