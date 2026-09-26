import { AUTOMATION_RECIPES } from "@skincrm/contracts";
import { getAutomationOptions } from "@/lib/automations";
import { requireCapability } from "@/lib/session";
import { AutomationBuilder } from "../builder/builder";
import type { Draft } from "../builder/model";

export const metadata = { title: "New automation — SkinCRM" };

const BLANK: Draft = {
  name: "",
  trigger: { type: "lead_created", sources: [] },
  steps: [],
  stopWhen: ["booked", "closed"],
};

export default async function NewAutomationPage({ searchParams }: { searchParams: Promise<{ recipe?: string }> }) {
  await requireCapability("automations:write");
  const { recipe } = await searchParams;
  const options = await getAutomationOptions();
  const start = AUTOMATION_RECIPES.find((r) => r.key === recipe)?.rule ?? BLANK;

  return <AutomationBuilder id={null} initial={structuredClone(start)} status="paused" options={options} />;
}
