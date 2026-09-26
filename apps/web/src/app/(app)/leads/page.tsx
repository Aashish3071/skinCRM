import Link from "next/link";
import { LEAD_SOURCE_LABELS, type LeadDto } from "@skincrm/contracts";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { getLeads, getAssignees, getStages, relativeTime, stageTone, type PipelineStage } from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { LeadFilters } from "./filters";

export const metadata = { title: "Leads — SkinCRM" };

type Search = Record<string, string | string[] | undefined>;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("leads:read");
  const params = await searchParams;

  const view = single(params.view) === "board" ? "board" : "list";

  // Only forward filters the API knows about, so a stray query string cannot
  // produce a confusing 400.
  const query = new URLSearchParams();
  for (const key of ["search", "stageCategory", "ownerUserId", "source", "unassigned", "includeClosed"]) {
    const value = single(params[key]);
    if (value) query.set(key, value);
  }
  // The board needs every lead at once; the list is paged.
  query.set("limit", view === "board" ? "100" : "25");

  const [stages, data, staff] = await Promise.all([
    getStages(),
    getLeads(query.toString()),
    can(session, "leads:assign") ? getAssignees() : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Leads"
        description={`${data.totalCount} ${data.totalCount === 1 ? "inquiry" : "inquiries"} matching these filters.`}
        actions={
          can(session, "leads:write") ? (
            <Link
              href="/leads/new"
              className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-hover"
            >
              New inquiry
            </Link>
          ) : null
        }
      />

      <LeadFilters stages={stages} staff={staff} view={view} />

      <div className="mt-4">
        {data.items.length === 0 ? (
          <Card>
            <EmptyState title="No inquiries match these filters">
              Clear a filter, or add a walk-in with <strong>New inquiry</strong>.
            </EmptyState>
          </Card>
        ) : view === "board" ? (
          <KanbanBoard stages={stages} leads={data.items} counts={data.stageCounts} />
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
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Lead inquiries</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-subtle">
              <th scope="col" className="py-2 pr-4 font-medium">Person</th>
              <th scope="col" className="py-2 pr-4 font-medium">Stage</th>
              <th scope="col" className="py-2 pr-4 font-medium">Source</th>
              <th scope="col" className="py-2 pr-4 font-medium">Service</th>
              <th scope="col" className="py-2 pr-4 font-medium">Owner</th>
              <th scope="col" className="py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-b border-line last:border-0">
                <td className="py-3 pr-4">
                  <Link href={`/leads/${lead.id}`} className="font-medium text-brand hover:underline">
                    {lead.personName}
                  </Link>
                  <div className="text-xs text-ink-muted">{lead.personPhone ?? lead.personEmail ?? "—"}</div>
                </td>
                <td className="py-3 pr-4">
                  <Badge tone={stageTone(lead.stageCategory)}>{lead.stageName}</Badge>
                </td>
                <td className="py-3 pr-4 text-ink-muted">{LEAD_SOURCE_LABELS[lead.source]}</td>
                <td className="py-3 pr-4 text-ink-muted">{lead.serviceInterest ?? "—"}</td>
                <td className="py-3 pr-4">
                  {lead.ownerName ?? <span className="text-caution">Unassigned</span>}
                </td>
                <td className="py-3 text-ink-muted">{relativeTime(lead.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function KanbanBoard({
  stages,
  leads,
  counts,
}: {
  stages: PipelineStage[];
  leads: LeadDto[];
  counts: Record<string, number>;
}) {
  const byStage = new Map<string, LeadDto[]>();
  for (const lead of leads) {
    const bucket = byStage.get(lead.stageId) ?? [];
    bucket.push(lead);
    byStage.set(lead.stageId, bucket);
  }

  // Only show columns that hold something, plus the open stages, so a clinic
  // with eleven stages does not get eleven empty columns to scroll past.
  const visible = stages.filter((stage) => !stage.isClosed || (counts[stage.id] ?? 0) > 0);

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-3" style={{ minWidth: `${visible.length * 260}px` }}>
        {visible.map((stage) => {
          const items = byStage.get(stage.id) ?? [];
          const total = counts[stage.id] ?? 0;
          return (
            <section key={stage.id} className="w-64 shrink-0">
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-medium">{stage.name}</h2>
                <span className="text-xs tabular-nums text-ink-subtle">{total}</span>
              </header>
              <div className="flex flex-col gap-2">
                {items.map((lead) => (
                  <Link
                    key={lead.id}
                    href={`/leads/${lead.id}`}
                    className="block rounded-md border border-line bg-surface px-3 py-2.5 hover:border-line-strong"
                  >
                    <p className="text-sm font-medium">{lead.personName}</p>
                    {lead.serviceInterest && (
                      <p className="mt-0.5 text-xs text-ink-muted">{lead.serviceInterest}</p>
                    )}
                    <p className="mt-1.5 flex items-center justify-between text-xs text-ink-subtle">
                      <span>{lead.ownerName ?? "Unassigned"}</span>
                      <span>{relativeTime(lead.createdAt)}</span>
                    </p>
                  </Link>
                ))}
                {/* The board caps at 100 leads; say so rather than appearing to lose some. */}
                {total > items.length && (
                  <p className="px-1 text-xs text-ink-subtle">
                    + {total - items.length} more — use the list view
                  </p>
                )}
                {items.length === 0 && (
                  <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-ink-subtle">
                    Empty
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
