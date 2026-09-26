import { ChatIcon } from "@/components/icons";
import { loadList, type Search } from "./load";
import { requireCapability } from "@/lib/session";
import { InboxShell } from "./shell";

export const metadata = { title: "Inbox — SkinCRM" };


export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireCapability("conversations:read");
  const { view, search, list } = await loadList(await searchParams);
  return (
    <InboxShell list={list} view={view} search={search} selectedId={null}>
      <div className="wa-wallpaper flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--wa-panel)] text-[var(--wa-green)]">
          <ChatIcon size={36} />
        </span>
        <p className="text-2xl font-light text-[var(--wa-text)]">Your clinic&rsquo;s WhatsApp</p>
        <p className="max-w-sm text-sm text-[var(--wa-meta)]">
          Pick a chat on the left. Everyone on the team sees the same chats, and each one shows who is looking after it.
        </p>
      </div>
    </InboxShell>
  );
}
