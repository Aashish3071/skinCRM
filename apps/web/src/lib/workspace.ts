import "server-only";
import type { ActivityFeedItem, NoteFeedItem } from "@skincrm/contracts";
import { apiFetch } from "./api";

export const getNoteFeed = (query: string) =>
  apiFetch<{ items: NoteFeedItem[]; hasMore: boolean }>(`/notes?${query}`);

export const getActivityFeed = (query: string) =>
  apiFetch<{ items: ActivityFeedItem[]; hasMore: boolean }>(`/activities?${query}`);
