import Link from "next/link";
import { SetPasswordForm, SetPasswordShell } from "../set-password-form";

export const metadata = { title: "Choose a new password — SkinCRM" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <SetPasswordShell title="Choose a new password" lead="Pick something you haven't used here before.">
      {token ? (
        <SetPasswordForm mode="reset" token={token} />
      ) : (
        <p className="text-sm">
          This link is incomplete. <Link href="/forgot-password" className="text-brand underline">Request a new one</Link>.
        </p>
      )}
    </SetPasswordShell>
  );
}
