import { SetPasswordForm, SetPasswordShell } from "../set-password-form";

export const metadata = { title: "Join your clinic — SkinCRM" };

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <SetPasswordShell title="Join your clinic" lead="Set your name and a password to finish setting up your account.">
      {token ? (
        <SetPasswordForm mode="invite" token={token} />
      ) : (
        <p className="text-sm">This invitation link is incomplete. Ask your clinic admin to send it again.</p>
      )}
    </SetPasswordShell>
  );
}
