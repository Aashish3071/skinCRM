import { USER_ROLE_LABELS } from "@skincrm/contracts";
import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";
import { MyProfile } from "./client";

export const metadata = { title: "My profile — SkinCRM" };

/** Everyone's own page — not behind any admin permission. */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ mfa?: string }> }) {
  const session = await requireSession();
  const { mfa } = await searchParams;
  return (
    <>
      <PageHeader title="My profile" description="Your name, password and sign-in security." />
      <MyProfile
        name={session.fullName}
        email={session.email}
        role={USER_ROLE_LABELS[session.role]}
        mfaEnabled={session.mfaEnabled}
        mustEnableMfa={mfa === "required"}
        isAdmin={session.role === "admin"}
      />
    </>
  );
}
