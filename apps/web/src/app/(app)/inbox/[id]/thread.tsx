"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { SUPPRESSION_REASON_LABELS, type ConversationDetail, type TemplateDto } from "@skincrm/contracts";
import { ChevronLeftIcon, LockIcon, MoreIcon, SendIcon } from "@/components/icons";
import { clinicClock, dayLabel } from "@/lib/format";
import {
  addConversationNoteAction,
  assignConversationAction,
  markReadAction,
  replyAction,
  setConversationStatusAction,
  typingAction,
} from "@/lib/inbox-actions";
import { Avatar } from "../shell";

type MessageItem = Extract<ConversationDetail["items"][number], { kind: "message" }>;

/**
 * One chat, made to look and behave like WhatsApp: the patient on the left in
 * white, the clinic on the right in green, ticks for sent / delivered / read,
 * and the familiar bar at the bottom to type in. The CRM additions — internal
 * notes, who's handling it, why a message wasn't sent — are drawn as
 * WhatsApp-style system notices, so nothing looks foreign.
 */
export function Thread({ convo, timezone, templates, staff, canReply, canAssign, backHref }: {
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
  const input = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const windowOpen = Boolean(convo.windowOpenUntil);
  const approved = templates.filter((t) => t.whatsappTemplateName && t.whatsappStatus === "approved");
  const usableTemplates = windowOpen ? templates : approved;
  const needsTemplate = mode === "reply" && !windowOpen;

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

  // Grow the input with its text, up to about five lines, like WhatsApp.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const canSend = !pending && (templateKey ? true : text.trim().length > 0 && !needsTemplate);

  const send = () => {
    if (!canSend) return;
    setError(null);
    startTransition(async () => {
      const result = mode === "note"
        ? await addConversationNoteAction(convo.id, text)
        : await replyAction(convo.id, templateKey ? { templateKey } : { body: text });
      if (!result.ok) return setError(result.message);
      setText("");
      setTemplateKey("");
      router.refresh();
    });
  };

  const assign = (userId: string) =>
    startTransition(async () => { await assignConversationAction(convo.id, userId || null); router.refresh(); });
  const toggleDone = () =>
    startTransition(async () => { await setConversationStatusAction(convo.id, convo.status === "resolved" ? "open" : "resolved"); router.refresh(); });

  const items = convo.items;

  return (
    <>
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-2 bg-[var(--wa-panel)] px-2 sm:px-4">
        <Link href={backHref} aria-label="Back to chats" className="rounded-full p-2 text-[var(--wa-meta)] hover:text-[var(--wa-text)] md:hidden">
          <ChevronLeftIcon size={22} />
        </Link>
        <Link href={convo.leadId ? `/leads/${convo.leadId}` : `/people/${convo.personId}`} className="flex min-w-0 flex-1 items-center gap-3" title="Open their lead">
          <Avatar name={convo.personName} size={40} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{convo.personName}</span>
            <span className="block truncate text-xs text-[var(--wa-meta)]">
              {convo.replyingName ? <span className="text-[var(--wa-green)]">{convo.replyingName} is typing…</span>
                : `${convo.personPhone ?? "WhatsApp"} · ${convo.assignedName ? `with ${convo.assignedName}` : "unassigned"}`}
            </span>
          </span>
        </Link>
        {canReply && (
          <button type="button" onClick={toggleDone} disabled={pending}
            className="hidden h-9 items-center rounded-full border border-[var(--wa-green)] px-3.5 text-sm font-medium text-[var(--wa-green)] hover:bg-[var(--wa-green)] hover:text-white sm:flex">
            {convo.status === "resolved" ? "Reopen" : "Mark done"}
          </button>
        )}
        <details className="relative">
          <summary aria-label="Chat options" className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-full text-[var(--wa-meta)] hover:bg-black/5 dark:hover:bg-white/5">
            <MoreIcon size={20} />
          </summary>
          <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg bg-[var(--wa-list)] py-2 text-sm shadow-[var(--shadow-pop)]">
            {canAssign && (
              <label className="block px-4 py-2">
                <span className="text-xs text-[var(--wa-meta)]">Handled by</span>
                <select value={convo.assignedUserId ?? ""} disabled={pending} onChange={(e) => assign(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-line bg-[var(--wa-list)] px-2 text-sm">
                  <option value="">Nobody yet</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                </select>
              </label>
            )}
            {canReply && <button type="button" onClick={toggleDone} className="block w-full px-4 py-2.5 text-left hover:bg-[var(--wa-list-hover)] sm:hidden">{convo.status === "resolved" ? "Reopen chat" : "Mark as done"}</button>}
            <Link href={convo.leadId ? `/leads/${convo.leadId}` : `/people/${convo.personId}`} className="block px-4 py-2.5 hover:bg-[var(--wa-list-hover)]">Open their lead</Link>
            <Link href={`/people/${convo.personId}`} className="block px-4 py-2.5 hover:bg-[var(--wa-list-hover)]">Patient profile & notes</Link>
          </div>
        </details>
      </header>

      {/* Messages */}
      <div className="wa-wallpaper flex-1 overflow-y-auto px-3 py-3 sm:px-[6%]" aria-live="polite">
        <ol className="flex flex-col">
          {items.map((item, i) => {
            const prev = items[i - 1];
            const day = dayLabel(item.at, timezone);
            const newDay = !prev || dayLabel(prev.at, timezone) !== day;
            const sameSender = !newDay && prev?.kind === "message" && item.kind === "message" && prev.direction === item.direction;
            return (
              <li key={`${item.kind}-${item.id}`} className={`flex flex-col ${sameSender ? "mt-0.5" : "mt-2"}`}>
                {newDay && (
                  <span className="mx-auto mb-2 mt-1 rounded-lg bg-[var(--wa-chip)] px-3 py-1 text-xs uppercase tracking-wide text-[var(--wa-meta)] shadow-sm">{day}</span>
                )}
                {item.kind === "note" ? (
                  <div className="mx-auto my-1 max-w-[90%] rounded-lg bg-[var(--wa-note)] px-3 py-2 text-center text-[13px] text-[var(--wa-note-text)] shadow-sm sm:max-w-md">
                    <p className="flex items-center justify-center gap-1 text-[11px] font-semibold uppercase tracking-wide"><LockIcon size={11} /> Team note · not sent</p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words">{item.body}</p>
                    <p className="mt-1 text-[11px] opacity-75">{item.byLabel ?? "Someone"} · {clinicClock(item.at, timezone)}</p>
                  </div>
                ) : (
                  <Bubble item={item} tail={!sameSender} timezone={timezone} />
                )}
              </li>
            );
          })}
        </ol>
        {items.length === 0 && (
          <p className="mx-auto mt-6 max-w-xs rounded-lg bg-[var(--wa-note)] px-3 py-2 text-center text-xs text-[var(--wa-note-text)]">
            No messages yet. {windowOpen ? "Say hello." : "Start with an approved template — WhatsApp requires one for a first message."}
          </p>
        )}
        <div ref={bottom} className="h-1" />
      </div>

      {/* Composer */}
      {canReply && (
        <div className="shrink-0 bg-[var(--wa-panel)] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1">
            <div role="tablist" aria-label="What are you writing?" className="flex gap-1">
              {(["reply", "note"] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); input.current?.focus(); }}
                  className={`h-7 rounded-full px-3 text-xs font-medium ${
                    mode === m ? (m === "note" ? "bg-[var(--wa-note)] text-[var(--wa-note-text)]" : "bg-[#d9fdd3] text-[#0a5c36] dark:bg-[#103529] dark:text-[#25d366]") : "text-[var(--wa-meta)] hover:text-[var(--wa-text)]"
                  }`}>
                  {m === "reply" ? "Message" : "Team note"}
                </button>
              ))}
            </div>
            {mode === "reply" && (
              <span className="text-[11px] text-[var(--wa-meta)]">
                {windowOpen
                  ? `Free replies until ${clinicClock(convo.windowOpenUntil!, timezone)}${dayLabel(convo.windowOpenUntil!, timezone) === "Today" ? "" : ` ${dayLabel(convo.windowOpenUntil!, timezone)}`}`
                  : "Over 24 hours since they wrote — send an approved template"}
              </span>
            )}
          </div>

          {mode === "reply" && (usableTemplates.length > 0 || needsTemplate) && (
            <div className="mb-1.5 px-1">
              {usableTemplates.length > 0 ? (
                <select aria-label="Template" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}
                  className="h-9 w-full rounded-lg border-0 bg-[var(--wa-input)] px-3 text-sm text-[var(--wa-text)] sm:w-auto">
                  <option value="">{windowOpen ? "Use a template (optional)" : "Choose an approved template"}</option>
                  {usableTemplates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
                </select>
              ) : (
                <p className="text-xs text-[var(--wa-meta)]">No approved WhatsApp templates yet. Add one in Automations → Message templates.</p>
              )}
            </div>
          )}

          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label htmlFor="composer" className="sr-only">{mode === "reply" ? "Type a message" : "Write a team note"}</label>
            <textarea
              ref={input}
              id="composer"
              rows={1}
              value={text}
              disabled={pending || Boolean(templateKey) || needsTemplate}
              onChange={(e) => {
                setText(e.target.value);
                if (mode === "reply" && Date.now() - lastTyping.current > 20_000) {
                  lastTyping.current = Date.now();
                  void typingAction(convo.id);
                }
              }}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter adds a line — the WhatsApp habit.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={mode === "note" ? "Write a note only your team will see" : templateKey ? "The template will be sent" : needsTemplate ? "Choose a template above" : "Type a message"}
              className={`max-h-[132px] min-h-11 flex-1 resize-none rounded-lg border-0 px-4 py-2.5 text-[15px] leading-6 text-[var(--wa-text)] placeholder:text-[var(--wa-meta)] disabled:opacity-70 ${mode === "note" ? "bg-[var(--wa-note)]" : "bg-[var(--wa-input)]"}`}
            />
            <button type="submit" disabled={!canSend} aria-label={mode === "note" ? "Save note" : "Send"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--wa-send)] text-white shadow-sm transition-opacity disabled:opacity-40">
              <SendIcon size={20} />
            </button>
          </form>
          {error && <p role="alert" className="mt-1.5 px-1 text-sm text-critical">{error}</p>}
        </div>
      )}
    </>
  );
}

function Bubble({ item, tail, timezone }: { item: MessageItem; tail: boolean; timezone: string }) {
  const out = item.direction === "outbound";
  const failed = item.state === "suppressed" || item.state === "failed" || item.state === "bounced";
  const why = item.suppressionReason ? SUPPRESSION_REASON_LABELS[item.suppressionReason] : item.failureDetail;
  const by = out ? (item.automationName ? `Automation · ${item.automationName}` : item.byLabel) : null;

  return (
    <div className={`flex flex-col ${out ? "items-end" : "items-start"}`}>
      <div
        className={`relative max-w-[85%] rounded-lg px-2.5 pb-1.5 pt-1.5 text-[15px] leading-[1.35] text-[var(--wa-text)] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)] sm:max-w-[65%] ${
          out ? "bg-[var(--wa-out)]" : "bg-[var(--wa-in)]"
        } ${tail ? (out ? "wa-tail-out rounded-tr-none" : "wa-tail-in rounded-tl-none") : ""} ${failed ? "opacity-80 outline outline-1 outline-dashed outline-critical" : ""}`}
      >
        {by && tail && <p className="mb-0.5 text-[12px] font-medium text-[var(--wa-green)]">{by}</p>}
        <span className="whitespace-pre-wrap break-words">
          {item.body ?? <em className="text-[var(--wa-meta)]">Not sent — the message was never written out</em>}
        </span>
        {/* Invisible spacer so the time never overlaps the last line, as in WhatsApp. */}
        <span aria-hidden="true" className="inline-block w-[4.5rem]" />
        <span className="float-right -mb-1 ml-2 mt-1 flex translate-y-0.5 items-center gap-1 text-[11px] text-[var(--wa-meta)]">
          {clinicClock(item.at, timezone)}
          {out && <Ticks state={item.state} />}
        </span>
      </div>
      {failed && (
        <p className="mt-0.5 max-w-[85%] px-1 text-right text-[11px] text-critical sm:max-w-[65%]">Not sent{why ? `: ${why}` : ""}</p>
      )}
    </div>
  );
}

/** ✓ sent · ✓✓ delivered · blue ✓✓ read · ! not sent. Each has a spoken label. */
function Ticks({ state }: { state: string }) {
  if (state === "suppressed" || state === "failed" || state === "bounced") {
    return <span role="img" aria-label="Not sent" className="font-bold text-critical">!</span>;
  }
  if (state === "sending" || state === "queued" || state === "scheduled") {
    return <span role="img" aria-label="Sending">🕓</span>;
  }
  const double = state === "delivered" || state === "read";
  const colour = state === "read" ? "var(--wa-tick-read)" : "var(--wa-meta)";
  return (
    <svg role="img" aria-label={state === "read" ? "Read" : double ? "Delivered" : "Sent"} width={double ? 16 : 12} height="11" viewBox={double ? "0 0 16 11" : "0 0 12 11"} fill="none" stroke={colour} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 6l3 3 7-7" />
      {double && <path d="M6 9l1 0.5 7-7.5" />}
    </svg>
  );
}
