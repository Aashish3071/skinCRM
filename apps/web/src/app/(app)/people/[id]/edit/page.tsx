import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getPerson } from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { apiFetch } from "@/lib/api";
import { PersonEditForm } from "./form";

export const metadata = { title: "Edit patient — SkinCRM" };

export default async function EditPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("people:write");
  const { id } = await params;
  const person = await getPerson(id);
  if (person.mergedIntoPersonId) redirect(`/people/${person.mergedIntoPersonId}`);
  const branches = can(session, "settings:read")
    ? (await apiFetch<{ items: { id: string; name: string }[] }>("/branches")).items
    : null;

  return (
    <>
      <PageHeader title={`Edit ${person.displayName}`} description="Update contact and profile details." actions={<Link href={`/people/${id}`} className="text-sm text-ink-muted hover:text-ink">Back to patient</Link>} />
      <PersonEditForm person={person} branches={branches} />
    </>
  );
}
