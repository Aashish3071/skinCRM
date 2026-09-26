import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { getPeople, relativeTime } from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { PeopleSearch } from "./search";

export const metadata = { title: "Patients — SkinCRM" };

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("people:read");
  const params = await searchParams;
  const search = typeof params.search === "string" ? params.search : "";

  const query = new URLSearchParams({ limit: "50" });
  if (search) query.set("search", search);

  const { items, totalCount } = await getPeople(query.toString());

  return (
    <>
      <PageHeader
        title="Patients"
        description={`${totalCount} ${totalCount === 1 ? "person" : "people"}. One person can have many inquiries over time.`}
        actions={
          can(session, "people:merge") ? (
            <Link href="/people/duplicates" className="text-sm text-brand">
              Review duplicates
            </Link>
          ) : null
        }
      />

      <PeopleSearch initial={search} />

      <div className="mt-4">
        <Card>
          {items.length === 0 ? (
            <EmptyState title={search ? "Nobody matches that search" : "No people yet"}>
              {search
                ? "Try part of a name, a phone number or an email address."
                : "Patients are added when an inquiry arrives, or from a walk-in."}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">People</caption>
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-subtle">
                    <th scope="col" className="py-2 pr-4 font-medium">Name</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Phone</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Email</th>
                    <th scope="col" className="py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((person) => (
                    <tr key={person.id} className="border-b border-line last:border-0">
                      <td className="py-3 pr-4">
                        <Link
                          href={`/people/${person.id}`}
                          className="font-medium text-brand hover:underline"
                        >
                          {person.displayName}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-ink-muted">
                        {person.phone ?? "—"}
                        {/* A number we could not parse still shows, flagged. */}
                        {person.phone && !person.phoneValid && (
                          <span className="ml-1.5 text-xs text-caution">unverified</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-ink-muted">{person.email ?? "—"}</td>
                      <td className="py-3 text-ink-muted">{relativeTime(person.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
