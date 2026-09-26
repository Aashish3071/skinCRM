import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requireCapability } from "@/lib/session";

export const metadata = { title: "Settings — SkinCRM" };

const SETTINGS_SECTIONS = [
  {
    href: "/settings/staff",
    title: "Staff and roles",
    description: "Invite staff, set roles and branch access, archive accounts.",
    ready: true,
    requirement: "ID-01",
  },
  {
    href: null,
    title: "Clinic and branches",
    description: "Timezone, working hours, branches, service types, follow-up SLA.",
    ready: false,
    requirement: "SET-01",
  },
  {
    href: null,
    title: "Pipeline",
    description: "Rename and reorder lead stages, set which exits need a reason.",
    ready: false,
    requirement: "LEAD-02",
  },
  {
    href: null,
    title: "Integrations",
    description: "Meta, Google, WhatsApp account and number, email sender domain.",
    ready: false,
    requirement: "INT-01",
  },
  {
    href: null,
    title: "Conversion feedback",
    description: "Map CRM milestones to ad-platform events, preview, eligibility gate, kill switch.",
    ready: false,
    requirement: "FB-01",
  },
  {
    href: null,
    title: "Privacy and retention",
    description: "Consent wording, notice version, retention periods, export and deletion.",
    ready: false,
    requirement: "MSG-04",
  },
  {
    href: null,
    title: "Audit log",
    description: "Sign-ins, admin actions, sensitive access, exports, merges, consent changes.",
    ready: false,
    requirement: "AUD-01",
  },
] as const;

export default async function SettingsPage() {
  const session = await requireCapability("settings:read");

  return (
    <>
      <PageHeader
        title="Settings"
        description={`Configuration for ${session.clinic.name}.`}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {SETTINGS_SECTIONS.map((section) => {
          const inner = (
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{section.title}</p>
                  <p className="mt-1 text-sm text-ink-muted">{section.description}</p>
                </div>
                {section.ready ? (
                  <Badge tone="positive">Ready</Badge>
                ) : (
                  <Badge tone="caution">Soon</Badge>
                )}
              </div>
              <p className="mt-3 font-mono text-xs text-ink-subtle">{section.requirement}</p>
            </Card>
          );

          return section.href ? (
            <Link key={section.title} href={section.href} className="block">
              {inner}
            </Link>
          ) : (
            <div key={section.title} className="opacity-70">
              {inner}
            </div>
          );
        })}
      </div>
    </>
  );
}
