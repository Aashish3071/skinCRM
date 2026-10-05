"use client";
import { useState, useTransition } from "react";
import { savePipeline } from "@/lib/crm-settings-actions";
export function Pipeline({
  initial,
  writable,
}: {
  initial: { id: string; name: string; category: string }[];
  writable: boolean;
}) {
  const [stages, setStages] = useState(initial),
    [notice, setNotice] = useState("");
  const [pending, start] = useTransition();
  function move(i: number, delta: number) {
    setStages((old) => {
      const next = [...old];
      [next[i], next[i + delta]] = [next[i + delta]!, next[i]!];
      return next;
    });
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await savePipeline(
            stages.map(({ id, name }) => ({ id, name })),
          );
          setNotice(r.ok ? "Pipeline saved." : r.message);
        });
      }}
    >
      {stages.map((s, i) => (
        <div key={s.id} className="flex items-center gap-3 rounded border p-3">
          <label className="flex-1">
            Stage {i + 1}
            <input
              aria-label={`Stage ${i + 1} name`}
              required
              maxLength={100}
              disabled={!writable || pending}
              className="ml-2 rounded border p-2"
              value={s.name}
              onChange={(e) =>
                setStages((old) =>
                  old.map((row) =>
                    row.id === s.id ? { ...row, name: e.target.value } : row,
                  ),
                )
              }
            />
          </label>
          {writable && (
            <>
              <button
                type="button"
                aria-label={`Move ${s.name} up`}
                disabled={i === 0 || pending}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${s.name} down`}
                disabled={i === stages.length - 1 || pending}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
            </>
          )}
        </div>
      ))}
      {writable && (
        <button className="rounded border px-3 py-2" disabled={pending}>
          Save pipeline
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </form>
  );
}
