import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One heading style for every group in the Notes and Activity feeds, whether
 * grouped by day, patient or inquiry: the name, then how many items sit under
 * it. The heading is a real <h2> so screen-reader users can jump group to group.
 */
export function FeedGroup({
  title,
  href,
  detail,
  count,
  noun,
  children,
}: {
  title: string;
  href?: string;
  detail?: string;
  count: number;
  noun: [singular: string, plural: string];
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        {href ? <Link href={href} className="hover:text-brand hover:underline">{title}</Link> : <span>{title}</span>}
        {detail && <span className="font-normal text-ink-muted">{detail}</span>}
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-muted">
          {count} {count === 1 ? noun[0] : noun[1]}
        </span>
      </h2>
      {children}
    </section>
  );
}
