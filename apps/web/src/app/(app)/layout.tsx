import { USER_ROLE_LABELS } from "@skincrm/contracts";
import { SideNav } from "@/components/nav";
import { logoutAction } from "@/lib/auth-actions";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-screen">
      {/* Keyboard users should be able to jump past the nav (WCAG 2.4.1). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-surface">
        <div className="flex h-14 items-center justify-between gap-4 px-4">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold tracking-tight text-brand">SkinCRM</span>
            <span className="text-sm text-ink-muted">{session.clinic.name}</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight">{session.fullName}</p>
              <p className="text-xs text-ink-muted">{USER_ROLE_LABELS[session.role]}</p>
            </div>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-muted"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className="hidden w-56 shrink-0 border-r border-line bg-surface md:block">
          <div className="sticky top-14">
            <SideNav capabilities={session.capabilities} />
          </div>
        </aside>

        <main id="main" className="min-w-0 flex-1 px-4 py-6 md:px-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>

      {/* Mobile nav: the front desk sometimes works from a tablet or phone. */}
      <div className="border-t border-line bg-surface md:hidden">
        <SideNav capabilities={session.capabilities} />
      </div>
    </div>
  );
}
