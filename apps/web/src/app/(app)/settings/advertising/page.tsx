import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { can, requireCapability } from "@/lib/session";
import { AdvertisingScreen, type AdvertisingOverview } from "./screen";

export const metadata = { title: "Advertising — SkinCRM" };

/** Settings → Advertising (D-95): campaigns, spend, budgets, audiences, history import. */
export default async function AdvertisingPage() {
  const session = await requireCapability("integrations:read");
  const data = await apiFetch<AdvertisingOverview>("/advertising");
  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader title="Advertising" description="Your Facebook and Google campaigns next to the leads, bookings and clients they brought — and the controls to act on it." />
      <AdvertisingScreen data={data} writable={can(session, "integrations:write")} />
    </>
  );
}
