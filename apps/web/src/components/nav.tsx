"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import type { Capability } from "@skincrm/contracts";
import { CalendarIcon, HomeIcon, LeadsIcon, PeopleIcon, SettingsIcon, ZapIcon } from "./icons";

/**
 * Main navigation.
 *
 * Only sections that work are listed. Inbox and Reports (phases 5 and 6)
 * return here when they exist — a menu full of "coming soon" is exactly the
 * kind of noise the front desk asked us to cut.
 *
 * `capability` decides whether a link renders at all. Presentation only: the
 * API enforces the same capability independently.
 */
export interface NavSection {
  href: string;
  label: string;
  capability: Capability | null;
  icon: ComponentType<{ size?: number }>;
  /** Shown in the phone tab bar, which has room for five. */
  mobile: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  { href: "/home", label: "Today", capability: null, icon: HomeIcon, mobile: true },
  { href: "/leads", label: "Leads", capability: "leads:read", icon: LeadsIcon, mobile: true },
  { href: "/calendar", label: "Calendar", capability: "appointments:read", icon: CalendarIcon, mobile: true },
  { href: "/people", label: "People", capability: "people:read", icon: PeopleIcon, mobile: true },
  { href: "/automations", label: "Automations", capability: "automations:read", icon: ZapIcon, mobile: false },
  { href: "/settings", label: "Settings", capability: "settings:read", icon: SettingsIcon, mobile: true },
];

function useVisible(capabilities: Capability[]) {
  const held = new Set(capabilities);
  return NAV_SECTIONS.filter((s) => s.capability === null || held.has(s.capability));
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SideNav({ capabilities }: { capabilities: Capability[] }) {
  const pathname = usePathname();
  const visible = useVisible(capabilities);

  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-0.5">
        {visible.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-brand-soft font-medium text-brand"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink"
                }`}
              >
                <Icon size={18} />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Phone tab bar: the few places the front desk goes all day, thumb-reachable. */
export function TabBar({ capabilities }: { capabilities: Capability[] }) {
  const pathname = usePathname();
  const visible = useVisible(capabilities).filter((s) => s.mobile).slice(0, 5);

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))` }}>
        {visible.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] ${
                  active ? "font-medium text-brand" : "text-ink-muted"
                }`}
              >
                <Icon size={20} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
