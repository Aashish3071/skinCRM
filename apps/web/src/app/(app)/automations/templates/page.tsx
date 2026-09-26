import Link from "next/link";
import { ChatIcon, MailIcon, PlusIcon } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader, buttonClasses } from "@/components/ui";
import { getTemplates } from "@/lib/messaging";
import { can, requireCapability } from "@/lib/session";

export const metadata = { title: "Message templates — SkinCRM" };

export default async function TemplatesPage() {
  const session = await requireCapability("templates:read");
  const templates = await getTemplates();
  const writable = can(session, "templates:write");

  return (
    <>
      <PageHeader
        title="Message templates"
        description="Messages you send again and again. Write them once, use them in automations."
        actions={
          writable ? (
            <Link href="/automations/templates/new" className={buttonClasses("primary")}>
              <PlusIcon size={16} /> New template
            </Link>
          ) : null
        }
      />
      {templates.length === 0 ? (
        <Card>
          <EmptyState title="No templates yet">
            {writable ? "Create one for the messages your clinic sends most — a booking confirmation is a good start." : "An admin can create them."}
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {templates.map((t) => {
            const Icon = t.channel === "email" ? MailIcon : ChatIcon;
            return (
              <li key={t.id}>
                <Link
                  href={`/automations/templates/${t.id}`}
                  className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)] hover:border-brand"
                >
                  <div className="flex items-start gap-3">
                    <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <Icon size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{t.name}</p>
                      <p className="truncate text-sm text-ink-muted">{t.subject ?? t.body.split("\n")[0]}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge>{t.channel === "email" ? "Email" : "WhatsApp"}</Badge>
                    <Badge tone={t.classification === "promotional" ? "caution" : "neutral"}>
                      {t.classification === "promotional" ? "Marketing" : "Service"}
                    </Badge>
                    {!t.isActive && <Badge tone="critical">Off</Badge>}
                    {t.channel === "whatsapp" && t.whatsappTemplateName && (
                      <Badge tone={t.whatsappStatus === "approved" ? "positive" : "caution"}>
                        Meta: {t.whatsappStatus ?? "draft"}
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-ink-subtle">v{t.version}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
