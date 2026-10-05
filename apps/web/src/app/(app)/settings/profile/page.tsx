import Link from "next/link";
import { USER_ROLE_LABELS } from "@skincrm/contracts";
import { PageHeader } from "@/components/ui";
import type { NotificationType } from "@skincrm/contracts";
import { apiFetch } from "@/lib/api";
import { requireSession } from "@/lib/session";
import { MyProfile } from "./client";
import { CalendarSyncCard, type CalendarSyncState } from "./calendar-sync";
import { can } from "@/lib/session";

export const metadata = { title: "My profile — SkinCRM" };

/** Everyone's own page — not behind any admin permission. */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ mfa?: string; calendar?: string; calendar_error?: string }> }) {
  const session = await requireSession();
  const { mfa, calendar, calendar_error: calendarError } = await searchParams;
  const canCalendar = can(session, "appointments:read");
  const [prefs, calendarSync] = await Promise.all([
    apiFetch<{ muted: NotificationType[] }>("/me/notification-settings"),
    canCalendar ? apiFetch<CalendarSyncState>("/me/calendar-sync") : Promise.resolve(null),
  ]);
  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader title="My profile" description="Your name, password, sign-in security and calendar." />
      <MyProfile
        name={session.fullName}
        email={session.email}
        role={USER_ROLE_LABELS[session.role]}
        mfaEnabled={session.mfaEnabled}
        mustEnableMfa={mfa === "required"}
        isAdmin={session.role === "admin"}
        muted={prefs.muted}
      />
      {calendarSync && (
        <div className="mt-4 max-w-2xl">
          <CalendarSyncCard
            state={calendarSync}
            banner={calendar === "connected" ? { ok: true, text: "Calendar connected. Your appointments are on their way into it." } : calendarError ? { ok: false, text: calendarError } : null}
          />
        </div>
      )}
    </>
  );
}
