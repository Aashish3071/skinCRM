import Link from "next/link";

export const metadata = { title: "No access — SkinCRM" };

export default function NoAccessPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">You do not have access to that</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Your role does not include this section. If you need it, ask an admin at your clinic to change your
        permissions.
      </p>
      <Link href="/home" className="mt-6 text-sm text-brand">
        Back to home
      </Link>
    </main>
  );
}
