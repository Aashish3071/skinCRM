import Link from "next/link";
import type { ComponentType } from "react";
import { CalendarIcon, ChevronRightIcon, FlagIcon, HomeIcon, LockIcon, PeopleIcon, ZapIcon } from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { can, requireCapability } from "@/lib/session";

export const metadata = { title: "Settings — SkinCRM" };

const SECTIONS: { href: string; title: string; description: string; icon: ComponentType<{ size?: number }>; capability: "users:read" | "settings:read" | "integrations:read" | "audit:read" }[] = [
  { href: "/settings/clinic", title: "Clinic profile", description: "Your clinic's name, logo, phone, address and time zone.", icon: HomeIcon, capability: "settings:read" },
  { href: "/settings/profile", title: "My profile", description: "Your name, password and two-step sign-in.", icon: PeopleIcon, capability: "settings:read" },
  { href: "/settings/integrations", title: "Lead sources & messaging", description: "Facebook and Google lead ads, WhatsApp number, email sending and marketing approval.", icon: ZapIcon, capability: "integrations:read" },
  { href: "/settings/lead-rules", title: "Lead rules", description: "Response-time target and who gets each new lead.", icon: FlagIcon, capability: "settings:read" },
  { href: "/settings/staff", title: "Staff and roles", description: "Invite your team, set what each person can see and do.", icon: PeopleIcon, capability: "users:read" },
  { href: "/settings/calendar", title: "Calendar", description: "Appointment types, how long they take, and everyone's working hours.", icon: CalendarIcon, capability: "settings:read" },
  { href: "/settings/audit", title: "Audit log", description: "Who signed in, changed, exported or viewed what — and when.", icon: LockIcon, capability: "audit:read" },
];

/** Only sections that work are listed; planned ones live in the roadmap (docs/HANDOFF.md). */
export default async function SettingsPage() {
  const session = await requireCapability("settings:read");
  return (
    <>
      <PageHeader title="Settings" description={`For ${session.clinic.name}.`} />
      <ul className="flex flex-col gap-3">
        {SECTIONS.filter((s) => can(session, s.capability)).map(({ href, title, description, icon: Icon }) => (
          <li key={href}>
            <Link href={href} className="flex items-center gap-4 rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)] hover:border-brand">
              <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <Icon size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{title}</span>
                <span className="block text-sm text-ink-muted">{description}</span>
              </span>
              <ChevronRightIcon size={18} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
