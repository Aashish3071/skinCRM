"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Capability } from "@skincrm/contracts";

/**
 * The nine sections from PRD section 6, in the order staff work through them.
 *
 * `capability` decides whether the link is rendered at all. This is presentation
 * only — the API enforces the same capability independently — but it matters that
 * a marketing analyst never sees a People link they cannot use.
 */
export interface NavSection {
  href: string;
  label: string;
  capability: Capability | null;
  /** Shown as a muted suffix while the section is a placeholder. */
  pending?: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  { href: "/home", label: "Home", capability: null },
  { href: "/inbox", label: "Inbox", capability: "conversations:read", pending: true },
  { href: "/leads", label: "Leads", capability: "leads:read", pending: true },
  { href: "/people", label: "People", capability: "people:read", pending: true },
  { href: "/calendar", label: "Calendar", capability: "appointments:read", pending: true },
  { href: "/automations", label: "Automations", capability: "automations:read", pending: true },
  { href: "/reports", label: "Reports", capability: "reports:read", pending: true },
  { href: "/settings", label: "Settings", capability: "settings:read" },
];

export function SideNav({ capabilities }: { capabilities: Capability[] }) {
  const pathname = usePathname();
  const held = new Set(capabilities);
  const visible = NAV_SECTIONS.filter((s) => s.capability === null || held.has(s.capability));

  return (
    <nav aria-label="Main" className="px-3 py-4">
      <ul className="flex flex-col gap-0.5">
        {visible.map((section) => {
          const active = pathname === section.href || pathname.startsWith(`${section.href}/`);
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                  active
                    ? "bg-brand-soft font-medium text-brand"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink"
                }`}
              >
                <span>{section.label}</span>
                {section.pending && (
                  <span className="text-[10px] uppercase tracking-wide text-ink-subtle">
                    soon
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
