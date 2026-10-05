"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBranch, archiveBranch } from "@/lib/crm-settings-actions";
export type Branch = {
  id: string;
  name: string;
  city: string | null;
  addressLine1: string | null;
  timezone: string | null;
  isDefault: boolean;
};
export function Branches({
  items,
  writable,
}: {
  items: Branch[];
  writable: boolean;
}) {
  const [editing, setEditing] = useState<Branch | null>(null),
    [show, setShow] = useState(false),
    [notice, setNotice] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {items.map((b) => (
          <li key={b.id} className="rounded border border-line bg-surface p-4">
            <strong>{b.name}</strong>
            {b.isDefault && " · Default"}
            <p>
              {[b.addressLine1, b.city, b.timezone].filter(Boolean).join(" · ")}
            </p>
            {writable && (
              <div className="mt-2 flex gap-3">
                <button
                  onClick={() => {
                    setEditing(b);
                    setShow(true);
                  }}
                >
                  Edit
                </button>
                {!b.isDefault && (
                  <button
                    disabled={pending}
                    onClick={() => {
                      if (
                        confirm(
                          `Archive ${b.name}? Its historical records will remain.`,
                        )
                      )
                        start(async () => {
                          const r = await archiveBranch(b.id);
                          setNotice(r.ok ? "Branch archived." : r.message);
                          router.refresh();
                        });
                    }}
                  >
                    Archive
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {writable && (
        <button
          className="rounded border px-3 py-2"
          onClick={() => {
            setEditing(null);
            setShow(true);
          }}
        >
          Add branch
        </button>
      )}
      {show && (
        <form
          key={editing?.id ?? "new"}
          className="space-y-3 rounded border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            start(async () => {
              const r = await saveBranch(editing?.id ?? null, {
                name: String(f.get("name")),
                city: String(f.get("city") || "") || null,
                addressLine1: String(f.get("addressLine1") || "") || null,
                timezone: String(f.get("timezone") || "") || null,
                isDefault: f.get("isDefault") === "on",
              });
              setNotice(r.ok ? "Branch saved." : r.message);
              if (r.ok) {
                setShow(false);
                router.refresh();
              }
            });
          }}
        >
          {(
            [
              ["name", "Branch name"],
              ["addressLine1", "Address"],
              ["city", "City"],
              ["timezone", "Time zone (leave blank to use clinic time zone)"],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="block">
              {label}
              <input
                className="mt-1 block w-full rounded border p-2"
                name={field}
                required={field === "name"}
                defaultValue={editing?.[field] ?? ""}
              />
            </label>
          ))}
          <label className="block">
            <input
              type="checkbox"
              name="isDefault"
              defaultChecked={editing?.isDefault}
            />{" "}
            Default branch
          </label>
          <button disabled={pending} className="rounded border px-3 py-2">
            Save branch
          </button>
          <button type="button" className="ml-3" onClick={() => setShow(false)}>
            Cancel
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
