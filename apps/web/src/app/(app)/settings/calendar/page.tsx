import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireCapability } from "@/lib/session";
import { getCalendarOptions, getConsultationTypes, getWorkingHours } from "@/lib/calendar";
import { CalendarSettings } from "./settings-client";

export const metadata = { title: "Calendar settings — SkinCRM" };
export default async function CalendarSettingsPage() {
  const session = await requireCapability("settings:write");
  const [options, types, hours] = await Promise.all([getCalendarOptions(), getConsultationTypes(), getWorkingHours()]);
  return <>
    <PageHeader title="Calendar settings" description={`Consultation types and working hours in ${session.clinic.timezone}.`} actions={<Link href="/calendar" className="text-sm text-brand">Back to calendar</Link>} />
    <CalendarSettings options={options} types={types} hours={hours} />
  </>;
}
