import Link from "next/link";
import { requestResetAction } from "./actions";
import { ForgotPasswordForm } from "./form";

export const metadata = { title: "Reset your password — SkinCRM" };

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1.5 text-sm text-ink-muted">
        Enter your work email and we will send a link to set a new password.
      </p>

      <div className="mt-6 rounded-card border border-line bg-surface p-6">
        <ForgotPasswordForm action={requestResetAction} />
      </div>

      <Link href="/login" className="mt-6 text-center text-sm text-brand">
        Back to sign in
      </Link>
    </main>
  );
}
