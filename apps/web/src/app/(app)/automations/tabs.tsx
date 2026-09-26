"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/automations", label: "Automations" },
  { href: "/automations/templates", label: "Message templates" },
  { href: "/automations/messages", label: "Sent messages" },
];

/**
 * The three parts of messaging, as tabs. Scrolls sideways on a narrow phone
 * rather than wrapping into two ragged rows.
 */
export function AutomationTabs() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === "/automations"
      ? !pathname.startsWith("/automations/templates") && !pathname.startsWith("/automations/messages")
      : pathname.startsWith(href);

  return (
    <nav aria-label="Messaging" className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0">
      <ul className="flex gap-1">
        {TABS.map((tab) => (
          <li key={tab.href} className="shrink-0">
            <Link
              href={tab.href}
              aria-current={active(tab.href) ? "page" : undefined}
              className={`-mb-px inline-block border-b-2 px-3 pb-2.5 pt-1 text-sm ${
                active(tab.href) ? "border-brand font-medium text-brand" : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
