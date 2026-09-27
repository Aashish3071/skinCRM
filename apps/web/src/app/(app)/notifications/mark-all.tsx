"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { buttonClasses } from "@/components/ui";
import { markAllReadAction } from "@/lib/notification-actions";

export function MarkAllRead() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => start(async () => { await markAllReadAction(); router.refresh(); })} className={buttonClasses("secondary")}>
      Mark all as read
    </button>
  );
}
