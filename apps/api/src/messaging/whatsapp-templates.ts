import { and, eq, isNull } from "drizzle-orm";
import { getEnv } from "@skincrm/config";
import {
  listWhatsAppTemplates,
  type WhatsAppTemplate,
} from "@skincrm/connectors";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest } from "../errors";
import { getConnection, secretOf } from "../integrations/connections";
import {
  extractVariables,
  ALL_TEMPLATE_VARIABLE_NAMES,
  TEMPLATE_VARIABLES,
} from "./render";
import { recordAudit } from "../audit";
const { messageTemplates } = schema;

export async function templateCatalogue(): Promise<WhatsAppTemplate[]> {
  const c = await getConnection("whatsapp_cloud");
  if (!c) throw badRequest("Connect WhatsApp in Settings first.");
  if (getEnv().CONNECTOR_WHATSAPP === "mock")
    return [
      {
        id: "mock_greeting",
        name: "hello_patient",
        language: "en",
        status: "APPROVED",
        category: "UTILITY",
        components: [
          { type: "BODY", text: "Hello {{1}}, thank you for contacting us." },
        ],
      },
    ];
  const token = secretOf(c);
  if (!token || !c.config.businessAccountId)
    throw badRequest(
      "Reconnect WhatsApp to grant access to the business account's templates.",
    );
  return listWhatsAppTemplates(c.config.businessAccountId, token);
}

export function supportedTemplate(t: WhatsAppTemplate): boolean {
  return (
    Boolean(t.components.find((c) => c.type === "BODY" && c.text)) &&
    t.category !== "AUTHENTICATION" &&
    t.components.every(
      (c) =>
        c.type === "BODY" ||
        c.type === "FOOTER" ||
        (c.type === "HEADER" && c.format === "TEXT" && !c.text?.includes("{{")),
    )
  );
}
function matches(
  row: typeof messageTemplates.$inferSelect,
  remote: WhatsAppTemplate,
): boolean {
  const variables = extractVariables(row.body);
  const positional = row.body.replace(
    /{{\s*([^{}]+?)\s*}}/g,
    (_match, name: string) => `{{${variables.indexOf(name.trim()) + 1}}}`,
  );
  return (
    supportedTemplate(remote) &&
    positional === remote.components.find((c) => c.type === "BODY")?.text &&
    row.classification ===
      (remote.category === "MARKETING" ? "promotional" : "operational")
  );
}
export async function refreshTemplateApproval(
  row: typeof messageTemplates.$inferSelect,
  catalogue?: WhatsAppTemplate[],
) {
  const remote = (catalogue ?? (await templateCatalogue())).find(
    (t) =>
      t.name === row.whatsappTemplateName &&
      t.language === row.whatsappLanguageCode,
  );
  const status = !remote
    ? "disabled"
    : !matches(row, remote)
      ? "draft"
      : remote.status === "APPROVED"
        ? "approved"
        : remote.status === "PAUSED"
          ? "paused"
          : remote.status === "REJECTED"
            ? "rejected"
            : remote.status === "PENDING"
              ? "pending"
              : "disabled";
  await getTx()
    .update(messageTemplates)
    .set({ whatsappStatus: status, updatedAt: new Date() })
    .where(eq(messageTemplates.id, row.id));
  return status;
}
export async function syncTemplates() {
  const catalogue = await templateCatalogue();
  const rows = await getTx()
    .select()
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.channel, "whatsapp"),
        isNull(messageTemplates.archivedAt),
      ),
    );
  for (const row of rows)
    if (row.whatsappTemplateName) await refreshTemplateApproval(row, catalogue);
  await recordAudit({
    action: "record_updated",
    entityType: "whatsapp_templates",
    changeSummary: { checked: rows.length },
  });
  return {
    items: catalogue.map((t) => ({ ...t, supported: supportedTemplate(t) })),
    variables: ALL_TEMPLATE_VARIABLE_NAMES.map((key) => ({
      key,
      label: TEMPLATE_VARIABLES[key],
    })),
  };
}
export async function importTemplate(id: string, variables: string[]) {
  const t = (await templateCatalogue()).find((t) => t.id === id);
  if (!t || !supportedTemplate(t))
    throw badRequest(
      "Choose a supported text template from the connected WhatsApp account.",
    );
  const text = t.components.find((c) => c.type === "BODY")!.text!;
  const positions = [...text.matchAll(/{{(\d+)}}/g)].map((m) => Number(m[1]));
  const count = Math.max(0, ...positions);
  if (count > 30 || [...new Set(positions)].some((n, i) => n !== i + 1))
    throw badRequest(
      "Use consecutively numbered template parameters in order, starting at 1.",
    );
  if (
    variables.length !== count ||
    new Set(variables).size !== variables.length ||
    variables.some((v) => !ALL_TEMPLATE_VARIABLE_NAMES.includes(v))
  )
    throw badRequest(
      "Choose a different CRM field for each template variable.",
    );
  const body = text.replace(
    /{{(\d+)}}/g,
    (_m, n: string) => `{{${variables[Number(n) - 1]}}}`,
  );
  if (body.includes("{{") && extractVariables(body).length !== count)
    throw badRequest(
      "Named template parameters are not supported. Use positional parameters in Meta.",
    );
  const tx = getTx();
  const existing = (
    await tx
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.whatsappTemplateName, t.name),
          eq(messageTemplates.whatsappLanguageCode, t.language),
          isNull(messageTemplates.archivedAt),
        ),
      )
  )[0];
  const value = {
    name: t.name,
    channel: "whatsapp" as const,
    classification:
      t.category === "MARKETING"
        ? ("promotional" as const)
        : ("operational" as const),
    body,
    allowedVariables: variables,
    whatsappTemplateName: t.name,
    whatsappLanguageCode: t.language,
    whatsappStatus:
      t.status === "APPROVED"
        ? ("approved" as const)
        : t.status === "REJECTED"
          ? ("rejected" as const)
          : t.status === "PAUSED"
            ? ("paused" as const)
            : t.status === "PENDING"
              ? ("pending" as const)
              : ("disabled" as const),
    isActive: true,
  };
  if (!matches({ ...value } as typeof messageTemplates.$inferSelect, t))
    throw badRequest(
      "This template content cannot be mapped to CRM fields. Use a positional text template.",
    );
  if (existing)
    await tx
      .update(messageTemplates)
      .set({ ...value, version: existing.version + 1, updatedAt: new Date() })
      .where(eq(messageTemplates.id, existing.id));
  else
    await tx
      .insert(messageTemplates)
      .values({
        ...value,
        clinicId: getContext().clinicId!,
        key: `wa_${t.id}_${t.language}`
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_"),
      });
  await recordAudit({
    action: "record_updated",
    entityType: "whatsapp_template",
    changeSummary: { providerTemplateId: t.id, language: t.language },
  });
  return { ok: true };
}
