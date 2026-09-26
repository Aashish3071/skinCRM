"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { SUPPRESSION_REASON_LABELS, type ConversationDetail, type TemplateDto } from "@skincrm/contracts";
import { ChevronLeftIcon, LockIcon, SendIcon } from "@/components/icons";
import { buttonClasses } from "@/components/ui";
import { clinicClock, dayLabel } from "@/lib/format";
import {
  addConversationNoteAction,
  assignConversationAction,
  markReadAction,
  replyAction,
  setConversationStatusAction,
  typingAction,
} from "@/lib/inbox-actions";

/**
 * One WhatsApp conversation.
 *
 * Patient on the left, the clinic on the right, internal notes as yellow
 * cards in between that say plainly they are never sent. Messages that were
 * blocked stay visible with the reason, so nobody assumes a reply went out.
 * The page refreshes itself every few seconds while open.
 */
export function Thread({
  convo,
  timezone,
  templates,
  staff,
  canReply,
  canAssign,
  backHref,
}: {
  convo: ConversationDetail;
  timezone: string;
  templates: TemplateDto[];
  staff: { id: string; fullName: string }[];
  canReply: boolean;
  canAssign: boolean;
  backHref: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const windowOpen = Boolean(convo.windowOpenUntil);
  const approved = templates.filter((t) => t.whatsappTemplateName && t.whatsappStatus === "approved");
  const usableTemplates = windowOpen ? templates : approved;

  useEffect(() => {
    if (convo.unreadCount > 0) void markReadAction(convo.id);
  }, [convo.id, convo.unreadCount]);

  useEffect(() => {
    const t = setInterval(() => router.refresh(), 8_000);
    return () => clearInterval(t);
  }, [router]);

  useLayoutEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [convo.items.length]);

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result =
        mode === "note"
          ? await addConversationNoteAction(convo.id, text)
          : await replyAction(convo.id, templateKey ? { templateKey } : { body: text });
      if (!result.ok) return setError(result.message);
      setText("");
      setTemplateKey("");
      router.refresh();
    });
  };

  const onType = (value: string) => {
    setText(value);
    if (mode === "reply" && Date.now() - lastTyping.current > 20_000) {
      lastTyping.current = Date.now();
      void typingAction(convo.id);
    }
  };

  let lastDay = "";

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <Link href={backHref} aria-label="Back to conversations" className="-ml-1 rounded-md p-2 text-ink-muted hover:bg-surface-muted md:hidden">
          <ChevronLeftIcon size={20} />
        </Link>
        <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
          <p className="truncate font-semibold">{convo.personName}</p>
          <p className="truncate text-xs text-ink-muted">
            {convo.personPhone ?? "WhatsApp"} ·{" "}
            <Link href={convo.leadId ? `/leads/${convo.leadId}` : `/people/${convo.personId}`} className="text-brand">
              {convo.leadId ? "Open lead" : "Open profile"}
            </Link>
          </p>
        </div>
        {canAssign && (
          <label className="flex flex-1 items-center gap-1.5 text-sm sm:flex-none">
            <span className="text-ink-muted sm:sr-only">Handled by</span>
            <select
              value={convo.assignedUserId ?? ""}
              disabled={pending}
              onChange={(e) => startTransition(async () => { await assignConversationAction(convo.id, e.target.value || null); router.refresh(); })}
              className="min-h-9 min-w-0 flex-1 rounded-lg sm:max-w-40 sm:flex-none border border-line-strong bg-surface px-2 text-sm"
            >
              <option value="">Unassigned</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select>
          </label>
        )}
        {canReply && (
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(async () => { await setConversationStatusAction(convo.id, convo.status === "resolved" ? "open" : "resolved"); router.refresh(); })}
            className={buttonClasses(convo.status === "resolved" ? "secondary" : "primary", "sm")}
          >
            {convo.status === "resolved" ? "Reopen" : "Mark done"}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto bg-surface-muted px-3 py-4 sm:px-6" aria-live="polite">
        {convo.items.length === 0 && <p className="py-10 text-center text-sm text-ink-muted">No messages yet.</p>}
        <ol className="flex flex-col gap-2">
          {convo.items.map((item) => {
            const day = dayLabel(item.at, timezone);
            const divider = day !== lastDay;
            lastDay = day;
            return (
              <li key={`${item.kind}-${item.id}`} className="flex flex-col">
                {divider && <p className="my-2 self-center rounded-full bg-surface px-3 py-0.5 text-xs text-ink-subtle">{day}</p>}
                {item.kind === "note" ? (
                  <div className="mx-auto w-full max-w-md rounded-lg border border-caution/40 bg-caution-soft px-3 py-2 text-sm">
                    <p className="mb-0.5 flex items-center gap-1 text-xs font-medium text-caution"><LockIcon size={12} /> Internal note — only your team sees this</p>
                    <p className="whitespace-pre-wrap break-words">{item.body}</p>
                    <p className="mt-1 text-xs text-ink-subtle">{item.byLabel ?? "Someone"} · {clinicClock(item.at, timezone)}</p>
                  </div>
                ) : (
                  <Bubble item={item} timezone={timezone} />
                )}
              </li>
            );
          })}
        </ol>
        <div ref={bottom} />
      </div>

      {canReply && (
        <div className="border-t border-line bg-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {convo.replyingName && (
            <p role="status" className="mb-2 rounded-lg bg-caution-soft px-3 py-1.5 text-xs text-caution">{convo.replyingName} is replying right now.</p>
          )}
          <div role="tablist" aria-label="Write" className="mb-2 flex gap-1">
            {(["reply", "note"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
                className={`min-h-8 rounded-full px-3 text-[13px] ${mode === m ? (m === "note" ? "bg-caution-soft font-medium text-caution" : "bg-brand-soft font-medium text-brand") : "text-ink-muted hover:bg-surface-muted"}`}>
                {m === "reply" ? "Reply to patient" : "Internal note"}
              </button>
            ))}
          </div>

          {mode === "reply" && (
            <p className="mb-2 text-xs text-ink-muted">
              {windowOpen
                ? `You can write freely until ${clinicClock(convo.windowOpenUntil!, timezone)} ${dayLabel(convo.windowOpenUntil!, timezone) === "Today" ? "today" : dayLabel(convo.windowOpenUntil!, timezone)}.`
                : "It's been more than 24 hours since they last wrote. WhatsApp only allows an approved template until they reply."}
            </p>
          )}

          {mode === "reply" && usableTemplates.length > 0 && (
            <label className="mb-2 flex items-center gap-2 text-sm">
              <span className="text-ink-muted">Template</span>
              <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} className="min-h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 text-sm">
                <option value="">{windowOpen ? "None — write my own" : "Choose an approved template"}</option>
                {usableTemplates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
              </select>
            </label>
          )}

          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (templateKey || text.trim()) send(); }}>
            <label htmlFor="composer" className="sr-only">{mode === "reply" ? "Message" : "Internal note"}</label>
            <textarea
              id="composer"
              rows={2}
              value={text}
              disabled={pending || (mode === "reply" && (Boolean(templateKey) || !windowOpen))}
              onChange={(e) => onType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (templateKey || text.trim()) send();
                }
              }}
              placeholder={mode === "note" ? "Only your team will see this" : templateKey ? "The template will be sent" : windowOpen ? "Write a reply" : "Choose a template above"}
              className={`min-h-11 flex-1 resize-none rounded-xl border bg-surface px-3 py-2.5 text-[15px] leading-snug placeholder:text-ink-subtle ${mode === "note" ? "border-caution/50" : "border-line-strong"}`}
            />
            <button type="submit" disabled={pending || (!templateKey && !text.trim())} aria-label={mode === "note" ? "Save note" : "Send"} className={`${buttonClasses("primary")} h-11 w-11 shrink-0 !px-0`}>
              <SendIcon size={18} />
            </button>
          </form>
          <p className="mt-1 hidden text-[11px] text-ink-subtle sm:block">Ctrl or ⌘ + Enter to send</p>
          {error && <p role="alert" className="mt-2 text-sm text-critical">{error}</p>}
        </div>
      )}
    </>
  );
}

function Bubble({ item, timezone }: { item: Extract<ConversationDetail["items"][number], { kind: "message" }>; timezone: string }) {
  const mine = item.direction === "outbound";
  const failed = item.state === "suppressed" || item.state === "failed" || item.state === "bounced";
  const why = item.suppressionReason ? SUPPRESSION_REASON_LABELS[item.suppressionReason] : item.failureDetail;
  return (
    <div className={`flex max-w-[85%] flex-col sm:max-w-[70%] ${mine ? "items-end self-end" : "items-start self-start"}`}>
      <div className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] leading-snug shadow-[var(--shadow-card)] ${
        failed ? "border border-dashed border-critical/50 bg-surface text-ink-muted" : mine ? "rounded-br-sm bg-brand-soft" : "rounded-bl-sm bg-surface"
      }`}>
        {item.body ?? <span className="italic">Message not written — it was never sent.</span>}
      </div>
      <p className="mt-0.5 px-1 text-[11px] text-ink-subtle">
        {mine && (item.automationName ? `Automation “${item.automationName}” · ` : item.byLabel ? `${item.byLabel} · ` : "")}
        {clinicClock(item.at, timezone)}
        {failed && <span className="text-critical"> · Not sent{why ? `: ${why}` : ""}</span>}
      </p>
    </div>
  );
}
