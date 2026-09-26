import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { clinicTime, getPerson, getPersonLeads, getPersonNotes, relativeTime } from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { NotesPanel } from "./notes";

export const metadata = { title: "Person — SkinCRM" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("people:read");
  const { id } = await params;

  const person = await getPerson(id);

  // This record was folded into another. Send the user to the survivor rather
  // than showing a record whose history has moved elsewhere.
  if (person.mergedIntoPersonId) {
    redirect(`/people/${person.mergedIntoPersonId}`);
  }

  const [notes, leads] = await Promise.all([
    can(session, "notes:read") ? getPersonNotes(id) : Promise.resolve([]),
    can(session, "leads:read") ? getPersonLeads(id) : Promise.resolve([]),
  ]);

  const tz = session.clinic.timezone;

  return (
    <>
      <PageHeader
        title={person.displayName}
        description={`Added ${relativeTime(person.createdAt)}`}
        actions={
          <Link href="/people" className="text-sm text-brand">
            Back to people
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-4">
          <Card title="Contact details">
            <dl className="flex flex-col gap-2 text-sm">
              <Row label="Phone" value={person.phone}>
                {person.phone && !person.phoneValid && (
                  <Badge tone="caution">Could not be read as a number</Badge>
                )}
              </Row>
              <Row label="Email" value={person.email} />
              <Row label="Preferred contact" value={person.preferredContactMethod} />
              <Row label="Language" value={person.preferredLanguage} />
              <Row label="City" value={person.city} />
            </dl>
            <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
              Some fields are hidden depending on your role. The API applies the same rule.
            </p>
          </Card>

          {can(session, "leads:read") && (
            <Card title="Inquiries" description={`${leads.length} over time`}>
              {leads.length === 0 ? (
                <EmptyState title="No inquiries yet" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {leads.map((lead) => (
                    <li key={lead.id}>
                      <Link
                        href={`/leads/${lead.id}`}
                        className="flex items-baseline justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm hover:border-line-strong"
                      >
                        <span>{lead.serviceInterest ?? "Inquiry"}</span>
                        <span className="shrink-0 text-xs text-ink-subtle">
                          {clinicTime(lead.createdAt, tz)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        {can(session, "notes:read") && (
          <NotesPanel
            personId={person.id}
            notes={notes}
            canWrite={can(session, "notes:write")}
            canArchive={can(session, "notes:archive")}
          />
        )}
      </div>
    </>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="flex flex-col items-end gap-1 text-right">
        <span>{value ?? "—"}</span>
        {children}
      </dd>
    </div>
  );
}
