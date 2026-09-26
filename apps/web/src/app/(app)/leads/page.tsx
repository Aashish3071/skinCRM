import Link from "next/link";
import { LEAD_SOURCE_LABELS, type LeadDto } from "@skincrm/contracts";
import { PlusIcon } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader, buttonClasses } from "@/components/ui";
import { getLeads, getStages, relativeTime, stageTone } from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { LeadBoard } from "./board";
import { LeadFilters } from "./filters";

export const metadata = { title: "Leads — SkinCRM" };

type Search = Record<string, string | string[] | undefined>;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("leads:read");
  const params = await searchParams;
  const view = single(params.view) === "list" ? "list" : "board";

  // Only forward filters the API knows about, so a stray query string cannot
  // produce a confusing 400.
  const query = new URLSearchParams();
  const search = single(params.search);
  if (search) query.set("search", search);
  if (single(params.unassigned) === "true") query.set("unassigned", "true");
  if (single(params.mine) === "true") query.set("ownerUserId", session.id);
  // The board needs every lead at once; the list is paged.
  query.set("limit", view === "board" ? "100" : "50");

  const [stages, data] = await Promise.all([getStages(), getLeads(query.toString())]);
  const filtered = Boolean(search || params.unassigned || params.mine);

  return (
    <>
      <PageHeader
        title="Leads"
        description={`${data.totalCount} ${data.totalCount === 1 ? "lead" : "leads"}${filtered ? " match" : ""}`}
        actions={
          can(session, "leads:write") ? (
            <Link href="/leads/new" className={buttonClasses("primary")}>
              <PlusIcon size={16} /> Add lead
            </Link>
          ) : null
        }
      />

      <LeadFilters view={view} canSeeAll={can(session, "leads:read_all")} />

      <div className="mt-5">
        {data.items.length === 0 && filtered ? (
          <Card>
            <EmptyState title="No leads match">Try a different search, or switch to Everyone.</EmptyState>
          </Card>
        ) : view === "board" ? (
          <LeadBoard stages={stages} leads={data.items} counts={data.stageCounts} canMove={can(session, "leads:write")} />
        ) : data.items.length === 0 ? (
          <Card>
            <EmptyState title="No leads yet">
              Add a walk-in with <strong>Add lead</strong>, or connect a lead form in Settings.
            </EmptyState>
          </Card>
        ) : (
          <LeadTable leads={data.items} />
        )}
      </div>
    </>
  );
}

function LeadTable({ leads }: { leads: LeadDto[] }) {
  return (
    <Card>
      <div className="-my-4 sm:-mx-5 sm:overflow-x-auto">
        <table className="stack-table w-full text-sm">
          <caption className="sr-only">Leads</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-subtle">
              <th scope="col" className="px-5 py-3 font-medium">Name</th>
              <th scope="col" className="px-3 py-3 font-medium">Stage</th>
              <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">Source</th>
              <th scope="col" className="hidden px-3 py-3 font-medium md:table-cell">Owner</th>
              <th scope="col" className="px-5 py-3 text-right font-medium">Added</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-b border-line last:border-0 hover:bg-surface-muted">
                <td className="px-5 py-3">
                  <Link href={`/leads/${lead.id}`} className="font-medium hover:text-brand">
                    {lead.personName}
                  </Link>
                  <div className="text-xs text-ink-muted">{lead.personPhone ?? lead.personEmail ?? "—"}</div>
                </td>
                <td data-label="Stage" className="px-3 py-3">
                  <Badge tone={stageTone(lead.stageCategory)}>{lead.stageName}</Badge>
                </td>
                <td className="hidden px-3 py-3 text-ink-muted sm:table-cell">{LEAD_SOURCE_LABELS[lead.source]}</td>
                <td className="hidden px-3 py-3 md:table-cell">
                  {lead.ownerName ?? <span className="text-caution">Unassigned</span>}
                </td>
                <td data-label="Added" className="px-5 py-3 text-right text-ink-muted">{relativeTime(lead.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
