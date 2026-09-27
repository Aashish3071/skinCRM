import Link from "next/link";
import { USER_ROLE_LABELS } from "@skincrm/contracts";
import { PageHeader } from "@/components/ui";
import type { NotificationType } from "@skincrm/contracts";
import { apiFetch } from "@/lib/api";
import { requireSession } from "@/lib/session";
import { MyProfile } from "./client";

export const metadata = { title: "My profile — SkinCRM" };

/** Everyone's own page — not behind any admin permission. */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ mfa?: string }> }) {
  const session = await requireSession();
  const { mfa } = await searchParams;
  const prefs = await apiFetch<{ muted: NotificationType[] }>("/me/notification-settings");
  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader title="My profile" description="Your name, password and sign-in security." />
      <MyProfile
        name={session.fullName}
        email={session.email}
        role={USER_ROLE_LABELS[session.role]}
        mfaEnabled={session.mfaEnabled}
        mustEnableMfa={mfa === "required"}
        isAdmin={session.role === "admin"}
        muted={prefs.muted}
      />
    </>
  );
}
