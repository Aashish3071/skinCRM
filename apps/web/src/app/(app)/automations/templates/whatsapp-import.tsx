"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  syncWhatsAppTemplatesAction,
  importWhatsAppTemplateAction,
} from "@/lib/template-actions";

type Result = Extract<
  Awaited<ReturnType<typeof syncWhatsAppTemplatesAction>>,
  { ok: true }
>;
export function WhatsAppImport() {
  const [catalogue, setCatalogue] = useState<Result["catalogue"] | null>(null);
  const [selected, setSelected] = useState("");
  const [mapping, setMapping] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const template = catalogue?.items.find((t) => t.id === selected);
  const body = template?.components.find((c) => c.type === "BODY")?.text ?? "";
  const count = Math.max(
    0,
    ...[...body.matchAll(/{{(\d+)}}/g)].map((m) => Number(m[1])),
  );
  return (
    <section className="mb-6 rounded-card border border-line bg-surface p-4">
      <h2 className="font-semibold">WhatsApp templates</h2>
      <p className="mb-3 text-sm text-ink-muted">
        Create and submit templates in WhatsApp Manager, then load them here.
        Match each placeholder to a CRM field. Approval and content are checked
        against your connected account.
      </p>
      <button
        type="button"
        className="rounded border px-3 py-2"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await syncWhatsAppTemplatesAction();
            if (result.ok) {
              setCatalogue(result.catalogue);
              setNotice("Approval statuses refreshed.");
              router.refresh();
            } else setNotice(result.message);
          })
        }
      >
        {pending ? "Working…" : "Load templates and refresh approvals"}
      </button>
      {catalogue && (
        <div className="mt-3 space-y-3">
          <label className="block">
            WhatsApp template
            <select
              className="ml-2 rounded border p-2"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setMapping([]);
              }}
            >
              <option value="">Choose a template</option>
              {catalogue.items.map((t) => (
                <option key={t.id} value={t.id} disabled={!t.supported}>
                  {t.name} · {t.language} · {t.status}
                  {!t.supported ? " · unsupported format" : ""}
                </option>
              ))}
            </select>
          </label>
          {template && (
            <>
              <p className="whitespace-pre-wrap rounded bg-slate-50 p-3">
                {body}
              </p>
              {count <= 30 &&
                Array.from({ length: count }, (_, i) => (
                  <label key={i} className="block">
                    Variable {i + 1}
                    <select
                      className="ml-2 rounded border p-2"
                      value={mapping[i] ?? ""}
                      onChange={(e) =>
                        setMapping((old) => {
                          const next = [...old];
                          next[i] = e.target.value;
                          return next;
                        })
                      }
                    >
                      <option value="">Choose a CRM field</option>
                      {catalogue.variables.map((v) => (
                        <option key={v.key} value={v.key}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              <button
                type="button"
                className="rounded border px-3 py-2"
                disabled={
                  pending ||
                  count > 30 ||
                  Array.from({ length: count }, (_, i) => !mapping[i]).some(
                    Boolean,
                  )
                }
                onClick={() =>
                  start(async () => {
                    const result = await importWhatsAppTemplateAction(
                      selected,
                      mapping,
                    );
                    setNotice(
                      result.ok
                        ? template.status === "APPROVED"
                          ? "Template imported and approved. Ready to use."
                          : "Template imported. It is usable once Meta approves it."
                        : result.message,
                    );
                    if (result.ok) router.refresh();
                  })
                }
              >
                Import template
              </button>
            </>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
