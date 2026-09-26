import { USER_ROLE_LABELS } from "@skincrm/contracts";
import { LogoutIcon } from "@/components/icons";
import { SideNav, TabBar } from "@/components/nav";
import { logoutAction } from "@/lib/auth-actions";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const initials = session.fullName
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-screen">
      {/* Keyboard users should be able to jump past the nav (WCAG 2.4.1). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-line bg-surface md:flex">
        <div className="px-5 pb-4 pt-5">
          <p className="text-[15px] font-semibold tracking-tight">{session.clinic.name}</p>
          <p className="text-xs text-ink-subtle">SkinCRM</p>
        </div>
        <div className="flex-1 overflow-y-auto px-3">
          <SideNav capabilities={session.capabilities} />
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand"
          >
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight">{session.fullName}</p>
            <p className="truncate text-xs text-ink-subtle">{USER_ROLE_LABELS[session.role]}</p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              aria-label="Sign out"
              title="Sign out"
              className="rounded-md p-2 text-ink-muted hover:bg-surface-muted hover:text-ink"
            >
              <LogoutIcon size={18} />
            </button>
          </form>
        </div>
      </aside>

      {/* Phone header */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface px-4 md:hidden">
        <p className="text-[15px] font-semibold tracking-tight">{session.clinic.name}</p>
        <form action={logoutAction}>
          <button type="submit" className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-muted">
            <LogoutIcon size={16} /> Sign out
          </button>
        </form>
      </header>

      <main id="main" className="px-4 pb-24 pt-6 md:ml-60 md:px-10 md:pb-10 md:pt-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      <TabBar capabilities={session.capabilities} />
    </div>
  );
}
