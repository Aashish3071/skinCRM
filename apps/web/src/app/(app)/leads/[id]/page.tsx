import Link from "next/link";
import { LEAD_SOURCE_LABELS } from "@skincrm/contracts";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import {
  clinicTime,
  getLead,
  getLeadTasks,
  getLeadTimeline,
  getPersonNotes,
  getAssignees,
  getStages,
  relativeTime,
  stageTone,
} from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { AddTaskForm, ContactAttemptForm, InquiryNoteForm, LeadActions, TaskRow } from "./client";

export const metadata = { title: "Lead — SkinCRM" };

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("leads:read");
  const { id } = await params;

  const lead = await getLead(id);
  const [stages, timeline, tasks, notes, staff] = await Promise.all([
    getStages(),
    getLeadTimeline(id),
    can(session, "tasks:read") ? getLeadTasks(id) : Promise.resolve([]),
    // General Notes belong to the person and follow them across every inquiry,
    // which is exactly why they are shown here and not only on the profile.
    can(session, "notes:read") ? getPersonNotes(lead.personId) : Promise.resolve([]),
    can(session, "leads:assign") ? getAssignees() : Promise.resolve([]),
  ]);

  const tz = session.clinic.timezone;
  const writable = can(session, "leads:write");

  return (
    <>
      <PageHeader
        title={lead.personName}
        description={`${LEAD_SOURCE_LABELS[lead.source]} · created ${relativeTime(lead.createdAt)}`}
        actions={
          <div className="flex items-center gap-4">
            {can(session, "appointments:write") && <Link href={`/calendar?leadId=${lead.id}`} className="rounded-md bg-brand px-3 py-2 text-sm text-white">Book appointment</Link>}
            <Link href="/leads" className="text-sm text-brand">Back to leads</Link>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title="Status">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
              <Detail label="Stage">
                <Badge tone={stageTone(lead.stageCategory)}>{lead.stageName}</Badge>
              </Detail>
              <Detail label="Owner">
                {lead.ownerName ?? <span className="text-caution">Unassigned</span>}
              </Detail>
              <Detail label="Service">{lead.serviceInterest ?? "—"}</Detail>
              {lead.lossReason && <Detail label="Reason">{lead.lossReason}</Detail>}
            </div>

            {writable && (
              <div className="mt-4 border-t border-line pt-4">
                <LeadActions
                  leadId={lead.id}
                  stages={stages}
                  currentStageId={lead.stageId}
                  staff={staff}
                  currentOwnerId={lead.ownerUserId}
                  canAssign={can(session, "leads:assign")}
                />
              </div>
            )}
          </Card>

          <Card title="Milestones" description="Recorded once, the first time each is reached.">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <Milestone label="First contacted" at={lead.firstContactedAt} tz={tz} />
              <Milestone label="Qualified" at={lead.qualifiedAt} tz={tz} />
              <Milestone label="Consultation booked" at={lead.bookedAt} tz={tz} />
              <Milestone label="Consultation attended" at={lead.attendedAt} tz={tz} />
              <Milestone label="Converted" at={lead.convertedAt} tz={tz} />
              <Milestone label="Closed" at={lead.closedAt} tz={tz} />
            </dl>
          </Card>

          {writable && (
            <Card title="Log a contact attempt" description="Every attempt is kept, connected or not.">
              <ContactAttemptForm leadId={lead.id} />
            </Card>
          )}

          <Card title="Timeline" description="Everything that has happened to this inquiry.">
            {timeline.length === 0 ? (
              <EmptyState title="Nothing yet" />
            ) : (
              <ol className="flex flex-col gap-3">
                {timeline.map((entry) => (
                  <li key={entry.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{entry.summary}</p>
                      <time
                        dateTime={entry.occurredAt}
                        title={clinicTime(entry.occurredAt, tz)}
                        className="text-xs text-ink-subtle"
                      >
                        {relativeTime(entry.occurredAt)}
                      </time>
                    </div>
                    {entry.body && (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{entry.body}</p>
                    )}
                    {entry.actorLabel && (
                      <p className="mt-1 text-xs text-ink-subtle">{entry.actorLabel}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {writable && (
            <Card
              title="Add a note to this inquiry"
              description="Scoped to this inquiry. For context that should follow the person everywhere, use General Notes."
            >
              <InquiryNoteForm leadId={lead.id} />
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card
            title="Person"
            actions={
              can(session, "people:read") ? (
                <Link href={`/people/${lead.personId}`} className="text-sm text-brand">
                  Open profile
                </Link>
              ) : null
            }
          >
            <dl className="flex flex-col gap-2 text-sm">
              <Row label="Name" value={lead.personName} />
              <Row label="Phone" value={lead.personPhone} />
              <Row label="Email" value={lead.personEmail} />
            </dl>
          </Card>

          {can(session, "notes:read") && (
            <Card
              title="General Notes"
              description="Belong to the person, so they appear on every inquiry."
            >
              {notes.length === 0 ? (
                <EmptyState title="No notes yet">
                  Add one from the person&rsquo;s profile.
                </EmptyState>
              ) : (
                <ul className="flex flex-col gap-3">
                  {notes.slice(0, 5).map((note) => (
                    <li key={note.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
                      {note.pinned && (
                        <div className="mb-1">
                          <Badge tone="caution">Pinned</Badge>
                        </div>
                      )}
                      <p className="whitespace-pre-wrap text-sm">{note.body}</p>
                      <p className="mt-1 text-xs text-ink-subtle">
                        {note.authorLabel ?? "Unknown"} · {relativeTime(note.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {can(session, "tasks:read") && (
            <Card title="Tasks">
              {tasks.length === 0 ? (
                <EmptyState title="No tasks" />
              ) : (
                <ul className="flex flex-col gap-3">
                  {tasks.map((task) => (
                    <TaskRow key={task.id} task={task} leadId={lead.id} canWrite={can(session, "tasks:write")} />
                  ))}
                </ul>
              )}
              {can(session, "tasks:write") && (
                <div className="mt-4 border-t border-line pt-4">
                  <AddTaskForm leadId={lead.id} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-subtle">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right">{value ?? "—"}</dd>
    </div>
  );
}

function Milestone({ label, at, tz }: { label: string; at: string | null; tz: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={at ? "" : "text-ink-subtle"}>{at ? clinicTime(at, tz) : "Not yet"}</dd>
    </div>
  );
}
