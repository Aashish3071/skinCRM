"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Capability } from "@skincrm/contracts";
import {
  ActivityIcon,
  CalendarIcon,
  HomeIcon,
  InboxIcon,
  LeadsIcon,
  MoreIcon,
  NotesIcon,
  PeopleIcon,
  ReportsIcon,
  SettingsIcon,
  XIcon,
  ZapIcon,
} from "./icons";

/**
 * Main navigation. Only sections that work are listed.
 *
 * `capability` decides whether a link renders at all. Presentation only: the
 * API enforces the same capability independently.
 */
export interface NavSection {
  href: string;
  label: string;
  capability: Capability | null;
  icon: ComponentType<{ size?: number }>;
  /** In the phone tab bar; everything else lives under "More". */
  primary: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  { href: "/home", label: "Home", capability: null, icon: HomeIcon, primary: true },
  { href: "/inbox", label: "Inbox", capability: "conversations:read", icon: InboxIcon, primary: true },
  { href: "/leads", label: "Leads", capability: "leads:read", icon: LeadsIcon, primary: true },
  { href: "/calendar", label: "Calendar", capability: "appointments:read", icon: CalendarIcon, primary: true },
  { href: "/people", label: "Patients", capability: "people:read", icon: PeopleIcon, primary: false },
  { href: "/notes", label: "Notes", capability: "notes:read", icon: NotesIcon, primary: false },
  { href: "/reports", label: "Reports", capability: "reports:read", icon: ReportsIcon, primary: false },
  { href: "/activity", label: "Activity", capability: "leads:read", icon: ActivityIcon, primary: false },
  { href: "/automations", label: "Automations", capability: "automations:read", icon: ZapIcon, primary: false },
  { href: "/settings", label: "Settings", capability: "settings:read", icon: SettingsIcon, primary: false },
];

function visibleFor(capabilities: Capability[]) {
  const held = new Set(capabilities);
  return NAV_SECTIONS.filter((s) => s.capability === null || held.has(s.capability));
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SideNav({ capabilities }: { capabilities: Capability[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-0.5">
        {visibleFor(capabilities).map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
                  active ? "bg-brand-soft font-medium text-brand" : "text-ink-muted hover:bg-surface-muted hover:text-ink"
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

/**
 * Phone tab bar: four everyday places plus "More", which opens a sheet with
 * the rest in large, labelled rows — no hunting through a hamburger menu.
 */
export function TabBar({ capabilities }: { capabilities: Capability[] }) {
  const pathname = usePathname();
  const all = visibleFor(capabilities);
  const tabs = all.filter((s) => s.primary).slice(0, 4);
  const rest = all.filter((s) => !tabs.includes(s));
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const moreActive = rest.some((s) => isActive(pathname, s.href));

  useEffect(() => {
    if (open) sheet.current?.showModal();
    else sheet.current?.close();
  }, [open]);
  useEffect(() => setOpen(false), [pathname]);

  const tabClass = (active: boolean) =>
    `flex min-h-14 w-full flex-col items-center justify-center gap-1 text-[11px] ${active ? "font-medium text-brand" : "text-ink-muted"}`;

  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length + (rest.length ? 1 : 0)}, minmax(0, 1fr))` }}>
          {tabs.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link href={href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
                  <Icon size={21} />
                  {label}
                </Link>
              </li>
            );
          })}
          {rest.length > 0 && (
            <li>
              <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className={tabClass(moreActive)}>
                <MoreIcon size={21} />
                More
              </button>
            </li>
          )}
        </ul>
      </nav>

      <dialog
        ref={sheet}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === sheet.current && setOpen(false)}
        aria-label="More sections"
        className="m-0 mt-auto w-full max-w-none rounded-t-2xl border-t border-line bg-surface p-0 text-ink backdrop:bg-black/40 md:hidden"
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <p className="font-semibold">More</p>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-2 text-ink-muted">
            <XIcon size={18} />
          </button>
        </div>
        <ul className="px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {rest.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className={`flex min-h-14 items-center gap-4 rounded-lg px-3 text-base ${isActive(pathname, href) ? "bg-brand-soft font-medium text-brand" : ""}`}
              >
                <Icon size={22} />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
