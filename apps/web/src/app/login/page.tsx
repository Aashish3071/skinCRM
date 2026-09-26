import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in — SkinCRM" };

export default async function LoginPage() {
  // Already signed in: don't show a form that would only confuse.
  if (await getSession()) redirect("/home");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold tracking-tight text-brand">SkinCRM</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Lead and appointment workspace for your clinic.
        </p>
      </div>

      <div className="rounded-card border border-line bg-surface p-6">
        <LoginForm showDevAccounts={process.env.NODE_ENV === "development"} />
      </div>
    </main>
  );
}
