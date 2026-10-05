import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Who publishes SkinCRM. Set per deployment (LEGAL_ENTITY_NAME,
 * LEGAL_CONTACT_EMAIL, LEGAL_ADDRESS); the defaults make a missing value
 * obvious rather than inventing one.
 */
export function legalEntity() {
  return {
    name: process.env.LEGAL_ENTITY_NAME || "[Your company name]",
    email: process.env.LEGAL_CONTACT_EMAIL || "[privacy contact email]",
    address: process.env.LEGAL_ADDRESS || "[postal address]",
    updated: process.env.LEGAL_UPDATED || "October 2026",
  };
}

/** Small links under public screens (sign-in, unsubscribe, booking). */
export function LegalFooter() {
  return (
    <footer className="mt-8 flex justify-center gap-4 text-xs text-ink-subtle">
      <Link href="/privacy" className="hover:text-ink">Privacy</Link>
      <Link href="/terms" className="hover:text-ink">Terms</Link>
    </footer>
  );
}

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  const entity = legalEntity();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <p className="text-sm font-semibold tracking-tight text-brand">SkinCRM</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-ink-muted">Last updated {entity.updated}. Published by {entity.name}.</p>
      <div className="legal mt-8 flex flex-col gap-6 text-[15px] leading-relaxed text-ink [&_h2]:text-lg [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1">
        {children}
      </div>
      <LegalFooter />
    </main>
  );
}
