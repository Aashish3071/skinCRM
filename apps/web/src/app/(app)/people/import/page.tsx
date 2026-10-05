import { requireCapability } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { ImportWizard } from "./client";
export default async function ImportPage() {
  await requireCapability("people:write");
  return (
    <>
      <PageHeader
        title="Import patients and inquiries"
        description="Upload a CSV, match its columns and review the result before importing. Existing matching patients are reused."
      />
      <ImportWizard />
    </>
  );
}
