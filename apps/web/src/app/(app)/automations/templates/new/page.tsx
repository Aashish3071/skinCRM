import { PageHeader } from "@/components/ui";
import { getTemplateVariables } from "@/lib/messaging";
import { requireCapability } from "@/lib/session";
import { TemplateEditor } from "../editor";

export const metadata = { title: "New template — SkinCRM" };

export default async function NewTemplatePage() {
  await requireCapability("templates:write");
  const variables = await getTemplateVariables();
  return (
    <>
      <PageHeader title="New template" />
      <TemplateEditor template={null} variables={variables} canWrite />
    </>
  );
}
