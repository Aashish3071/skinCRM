"use client";
import { useState, useTransition } from "react";
import { changeInquiryNoteAction } from "@/lib/crm-actions";
import { useRouter } from "next/navigation";
export function InquiryNoteControls({
  leadId,
  noteId,
  body,
  canArchive,
}: {
  leadId: string;
  noteId: string;
  body: string;
  canArchive: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(body),
    [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  function save(value: string | null) {
    start(async () => {
      const r = await changeInquiryNoteAction(leadId, noteId, value);
      if (!r.ok) setError(r.message);
      else {
        setEditing(false);
        router.refresh();
      }
    });
  }
  return (
    <div className="mt-2 text-xs">
      {editing ? (
        <>
          <textarea
            aria-label="Inquiry note"
            className="block w-full rounded border p-2 text-sm"
            maxLength={10000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button disabled={pending || !text.trim()} onClick={() => save(text)}>
            Save
          </button>
          <button className="ml-3" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button onClick={() => setEditing(true)}>Edit note</button>
          {canArchive && (
            <button
              className="ml-3"
              disabled={pending}
              onClick={() => {
                if (confirm("Archive this inquiry note?")) save(null);
              }}
            >
              Archive note
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
