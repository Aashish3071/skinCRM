import { InquiryNoteControls } from "./note-controls";
import Link from "next/link";
import { LEAD_SOURCE_LABELS } from "@skincrm/contracts";
import { CalendarIcon, MailIcon, PhoneIcon } from "@/components/icons";
import { Badge, Card, EmptyState, buttonClasses } from "@/components/ui";
import { WhatsAppButton } from "@/components/whatsapp-button";
import { SlaBadge } from "@/components/sla-badge";
import {
  clinicTime,
  getAssignees,
  getLead,
  getLeadTasks,
  getLeadTimeline,
  getPersonNotes,
  getStages,
  relativeTime,
} from "@/lib/crm";
import { can, requireCapability } from "@/lib/session";
import { AddTaskForm, QuickLog, TaskRow } from "./client";
import { OwnerPicker, StageStepper } from "./stepper";

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
    // which is why they are shown here and not only on the profile.
    can(session, "notes:read") ? getPersonNotes(lead.personId) : Promise.resolve([]),
    can(session, "leads:assign") ? getAssignees() : Promise.resolve([]),
  ]);

  const tz = session.clinic.timezone;
  const writable = can(session, "leads:write");
  const openTasks = tasks.filter((t) => t.status !== "completed" && t.status !== "canceled");
  const doneTasks = tasks.filter((t) => t.status === "completed");

  return (
    <>
      <Link href="/leads" className="text-sm text-ink-muted hover:text-ink">
        ← Leads
      </Link>

      <div className="mb-6 mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{lead.personName}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
            {lead.personPhone && (
              <a href={`tel:${lead.personPhone}`} className="inline-flex items-center gap-1.5 hover:text-brand">
                <PhoneIcon size={15} /> {lead.personPhone}
              </a>
            )}
            {lead.personEmail && (
              <a href={`mailto:${lead.personEmail}`} className="inline-flex items-center gap-1.5 hover:text-brand">
                <MailIcon size={15} /> {lead.personEmail}
              </a>
            )}
            <span>
              {LEAD_SOURCE_LABELS[lead.source]} · added {relativeTime(lead.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can(session, "conversations:read") && lead.personPhone && <WhatsAppButton personId={lead.personId} />}
          {can(session, "appointments:write") && (
            <Link href={`/calendar?leadId=${lead.id}`} className={buttonClasses("primary")}>
              <CalendarIcon size={16} /> Book appointment
            </Link>
          )}
        </div>
      </div>

      <Card>
        <StageStepper leadId={lead.id} stages={stages} currentStageId={lead.stageId} furthestPosition={lead.furthestPosition} canMove={writable} />
        <p className="mt-2 text-xs text-ink-subtle">Leads move forward only. Mark Won or Lost at any time.</p>
        <div className="mt-2"><SlaBadge lead={lead} long /></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          {can(session, "leads:assign") ? (
            <OwnerPicker leadId={lead.id} staff={staff} currentOwnerId={lead.ownerUserId} />
          ) : (
            <p className="text-sm text-ink-muted">Owner: {lead.ownerName ?? "Unassigned"}</p>
          )}
          {lead.lossReason && <p className="text-sm text-ink-muted">Reason: {lead.lossReason}</p>}
          {lead.bookedAt && !lead.closedAt && (
            <p className="text-sm text-ink-muted">Booked {clinicTime(lead.bookedAt, tz)}</p>
          )}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {writable && (
            <Card>
              <QuickLog leadId={lead.id} />
            </Card>
          )}

          <Card title="Activity">
            {timeline.length === 0 ? (
              <EmptyState title="Nothing yet" />
            ) : (
              <ol className="relative flex flex-col gap-4 border-l border-line pl-5">
                {timeline.map((entry) => (
                  <li key={entry.id} className="relative">
                    <span aria-hidden="true" className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-line-strong" />
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm">{entry.summary}</p>
                      <time dateTime={entry.occurredAt} title={clinicTime(entry.occurredAt, tz)} className="text-xs text-ink-subtle">
                        {relativeTime(entry.occurredAt)}
                      </time>
                    </div>
                    {entry.body && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{entry.body}</p>}
                    {writable && entry.type === "note" && <InquiryNoteControls leadId={lead.id} noteId={entry.id} body={entry.body ?? ""} canArchive={can(session, "notes:archive")} />}
                    {entry.actorLabel && <p className="mt-0.5 text-xs text-ink-subtle">{entry.actorLabel}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          {can(session, "tasks:read") && (
            <Card title="To do">
              {openTasks.length === 0 ? (
                <p className="text-sm text-ink-muted">Nothing to do.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {openTasks.map((task) => (
                    <TaskRow key={task.id} task={task} leadId={lead.id} canWrite={can(session, "tasks:write")} />
                  ))}
                </ul>
              )}
              {doneTasks.length > 0 && (
                <p className="mt-3 text-xs text-ink-subtle">{doneTasks.length} done</p>
              )}
              {can(session, "tasks:write") && (
                <details className="mt-4 border-t border-line pt-3">
                  <summary className="cursor-pointer text-sm font-medium text-brand">+ Add a task</summary>
                  <div className="mt-3">
                    <AddTaskForm leadId={lead.id} />
                  </div>
                </details>
              )}
            </Card>
          )}

          {can(session, "notes:read") && (
            <Card
              title="General notes"
              description="Follow the person to every inquiry."
              actions={
                can(session, "people:read") ? (
                  <Link href={`/people/${lead.personId}`} className="text-sm text-brand">
                    Profile
                  </Link>
                ) : null
              }
            >
              {notes.length === 0 ? (
                <p className="text-sm text-ink-muted">None yet. Add one from their profile.</p>
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
        </div>
      </div>
    </>
  );
}
