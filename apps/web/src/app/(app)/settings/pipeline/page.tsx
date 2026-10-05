import { getStages } from "@/lib/crm";
import { requireCapability, can } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { Pipeline } from "./client";
export default async function PipelinePage() {
  const session = await requireCapability("settings:read");
  return (
    <>
      <PageHeader
        title="Lead pipeline"
        description="Choose stage names and their display order. Booking, won and lost outcomes keep their meaning for automations and reporting."
      />
      <Pipeline
        initial={await getStages()}
        writable={can(session, "settings:write")}
      />
    </>
  );
}
