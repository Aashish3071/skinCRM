import "server-only";
import { INBOX_VIEWS, type InboxView } from "@skincrm/contracts";
import { getConversations } from "@/lib/inbox";

export type Search = Record<string, string | string[] | undefined>;

export async function loadList(params: Search) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const view = (INBOX_VIEWS as readonly string[]).includes(one(params.view) ?? "") ? (one(params.view) as InboxView) : "open";
  const search = one(params.search)?.trim() ?? "";
  const q = new URLSearchParams({ view });
  if (search) q.set("search", search);
  return { view, search, list: await getConversations(q.toString()) };
}

