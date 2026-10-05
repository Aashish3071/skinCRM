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
  const offset = Number(one(params.offset) ?? 0);
  if (Number.isInteger(offset) && offset > 0 && offset <= 1000000) q.set("offset", String(offset));
  return { view, search, list: await getConversations(q.toString()) };
}

