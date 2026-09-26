import { NotBuiltYet, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Calendar — SkinCRM" };

export default async function CalendarPage() {
  await requireSession();
  return (
    <>
      <PageHeader title="Calendar" />
      <NotBuiltYet
        phase="Phase 3"
        requirements={[
    "CAL-01",
    "CAL-02",
    "CAL-03",
    "CAL-04",
    "CAL-05",
        ]}
        summary="Day and week calendar by staff and branch, consultation types with duration and buffer, booking that rejects overlaps, appointment statuses separate from lead stage, and confirmation and reminder jobs."
      />
    </>
  );
}
