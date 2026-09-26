import { InboxIcon } from "@/components/icons";
import { loadList, type Search } from "./load";
import { requireCapability } from "@/lib/session";
import { InboxShell } from "./shell";

export const metadata = { title: "Inbox — SkinCRM" };


export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireCapability("conversations:read");
  const { view, search, list } = await loadList(await searchParams);
  return (
    <InboxShell list={list} view={view} search={search} selectedId={null}>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-ink-muted">
        <InboxIcon size={32} />
        <p className="font-medium text-ink">Pick a conversation</p>
        <p className="max-w-xs text-sm">WhatsApp messages from patients arrive here. Anyone on the team can answer; the thread shows who is handling it.</p>
      </div>
    </InboxShell>
  );
}
