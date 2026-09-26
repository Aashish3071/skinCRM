import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api";
import { getAssignees } from "@/lib/crm";
import { getConversation } from "@/lib/inbox";
import { getTemplates } from "@/lib/messaging";
import { can, requireCapability } from "@/lib/session";
import { loadList, type Search } from "../load";
import { InboxShell } from "../shell";
import { Thread } from "./thread";

export const metadata = { title: "Conversation — SkinCRM" };

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const session = await requireCapability("conversations:read");
  const { id } = await params;
  const [{ view, search, list }, convo, templates, staff] = await Promise.all([
    loadList(await searchParams),
    getConversation(id).catch((e) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
    can(session, "templates:read") ? getTemplates() : Promise.resolve([]),
    can(session, "conversations:assign") ? getAssignees() : Promise.resolve([]),
  ]);

  return (
    <InboxShell list={list} view={view} search={search} selectedId={id}>
      <Thread
        key={id}
        convo={convo}
        timezone={session.clinic.timezone}
        templates={templates.filter((t) => t.channel === "whatsapp" && t.isActive)}
        staff={staff}
        canReply={can(session, "messages:send")}
        canAssign={can(session, "conversations:assign")}
        backHref={`/inbox${view !== "open" ? `?view=${view}` : ""}`}
      />
    </InboxShell>
  );
}
