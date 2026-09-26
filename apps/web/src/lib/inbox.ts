import "server-only";
import type { ConversationDetail, ConversationSummary } from "@skincrm/contracts";
import { apiFetch } from "./api";

export interface InboxList {
  items: ConversationSummary[];
  counts: { open: number; unread: number; mine: number; unassigned: number };
  simulateAvailable: boolean;
}

export const getConversations = (query: string) => apiFetch<InboxList>(`/conversations?${query}`);
export const getConversation = (id: string) => apiFetch<ConversationDetail>(`/conversations/${id}`);
