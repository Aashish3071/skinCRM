"use server";

import { revalidatePath } from "next/cache";
import type { NotificationType } from "@skincrm/contracts";
import { apiFetch } from "./api";

export interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export async function loadNotificationsAction(limit = 15): Promise<{ unreadCount: number; items: NotificationItem[] }> {
  try {
    return await apiFetch(`/notifications?limit=${limit}`);
  } catch {
    return { unreadCount: 0, items: [] };
  }
}

export async function markReadAction(id: string): Promise<void> {
  await apiFetch(`/notifications/${id}/read`, { method: "POST" }).catch(() => undefined);
}

export async function markAllReadAction(): Promise<void> {
  await apiFetch("/notifications/read-all", { method: "POST" }).catch(() => undefined);
  revalidatePath("/notifications");
}

export async function saveMutedAction(muted: NotificationType[]): Promise<boolean> {
  try {
    await apiFetch("/me/notification-settings", { method: "PUT", body: { muted } });
    return true;
  } catch {
    return false;
  }
}
