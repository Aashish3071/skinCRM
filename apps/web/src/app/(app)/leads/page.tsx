import Link from "next/link";
import { LEAD_SOURCES, type LeadSource, type SavedViewDto } from "@skincrm/contracts";
import { PlusIcon } from "@/components/icons";
import { Card, EmptyState, PageHeader, buttonClasses } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { getAssignees, getLeads, getStages } from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { LeadBoard } from "./board";
import { LeadFilters } from "./filters";
import { LeadTable } from "./lead-table";

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
  const source = single(params.source);
  if (source && (LEAD_SOURCES as readonly string[]).includes(source)) query.set("source", source as LeadSource);
  const stage = single(params.stage);
  if (stage && /^[0-9a-f-]{36}$/.test(stage)) query.set("stageId", stage);
  if (single(params.awaiting) === "true") query.set("awaitingResponse", "true");
  const from = single(params.from);
  const to = single(params.to);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) query.set("createdFrom", from);
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) query.set("createdTo", to);
  // Test leads (from "Send a test lead") show with a badge; Reports excludes them.
  query.set("includeTest", "true");
  // The board needs every lead at once; the list is paged.
  query.set("limit", view === "board" ? "100" : "50");

  const canBulk = can(session, "leads:bulk_edit");
  const [stages, data, views, assignees] = await Promise.all([
    getStages(),
    getLeads(query.toString()),
    apiFetch<{ items: SavedViewDto[] }>("/saved-views?screen=leads").then((r) => r.items),
    canBulk && view === "list" ? getAssignees() : Promise.resolve([]),
  ]);
  const filtered = Boolean(search || params.unassigned || params.mine || source || stage || params.awaiting || from || to);

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

      <LeadFilters
        view={view}
        canSeeAll={can(session, "leads:read_all")}
        stages={stages.map((st) => ({ id: st.id, name: st.name }))}
        views={views}
        isAdmin={session.role === "admin"}
      />

      <div className="mt-5">
        {data.items.length === 0 && filtered ? (
          <Card>
            <EmptyState title="No leads match">Try a different search, clear some filters, or switch to Everyone.</EmptyState>
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
          <LeadTable leads={data.items} assignees={assignees} canBulk={canBulk} />
        )}
      </div>
    </>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
