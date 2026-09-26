import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getTemplateVariables, getTemplates } from "@/lib/messaging";
import { can, requireCapability } from "@/lib/session";
import { TemplateEditor } from "../editor";

export const metadata = { title: "Template — SkinCRM" };

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("templates:read");
  const { id } = await params;
  const [templates, variables] = await Promise.all([getTemplates(), getTemplateVariables()]);
  const template = templates.find((t) => t.id === id);
  if (!template) notFound();

  return (
    <>
      <PageHeader title={template.name} description={`Version ${template.version}. Editing creates a new version; sent messages keep the text they went out with.`} />
      <TemplateEditor key={template.version} template={template} variables={variables} canWrite={can(session, "templates:write")} />
    </>
  );
}
