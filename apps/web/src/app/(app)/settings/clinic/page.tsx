import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { can, requireCapability } from "@/lib/session";
import { ClinicForm } from "./form";

export const metadata = { title: "Clinic profile — SkinCRM" };

export interface ClinicSettings {
  name: string;
  phone: string | null;
  website: string | null;
  supportEmail: string | null;
  postalAddress: string | null;
  timezone: string;
  logoVersion: string | null;
}

export default async function ClinicPage() {
  const session = await requireCapability("settings:read");
  const clinic = await apiFetch<ClinicSettings>("/settings/clinic");
  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader title="Clinic profile" description="Your clinic's name, logo and contact details — shown in the CRM and in messages to patients." />
      <ClinicForm clinic={clinic} writable={can(session, "settings:write")} />
    </>
  );
}
