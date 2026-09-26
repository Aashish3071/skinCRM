import { NotBuiltYet, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export const metadata = { title: "People — SkinCRM" };

export default async function PeoplePage() {
  await requireSession();
  return (
    <>
      <PageHeader title="People" />
      <NotBuiltYet
        phase="Phase 2"
        requirements={[
    "ID-02",
    "ID-06",
    "ID-08",
        ]}
        summary="Person search and profile with the General Notes section, all of that person's inquiries, duplicate review and a reversible merge."
      />
    </>
  );
}
