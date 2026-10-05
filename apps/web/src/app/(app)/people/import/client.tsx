"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  previewImport,
  commitImport,
  type ImportPreview,
} from "@/lib/import-actions";
const fields = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  phone: "Phone",
  email: "Email",
  serviceInterest: "Inquiry interest",
  note: "Inquiry note",
  submittedAt: "Inquiry date",
};
export function ImportWizard() {
  const [csv, setCsv] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [reviewed, setReviewed] = useState(false),
    [skip, setSkip] = useState(false),
    [notice, setNotice] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="space-y-5">
      <label className="block">
        CSV file (up to 700 KB and 2,000 rows)
        <input
          className="mt-2 block"
          type="file"
          accept=".csv,text/csv"
          disabled={pending}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            setReviewed(false);
            setPreview(null);
            setCsv("");
            setNotice("");
            if (!file) return;
            if (file.size > 700_000) {
              setNotice("Split this file into files smaller than 700 KB.");
              return;
            }
            const text = await file.text();
            setCsv(text);
            start(async () => {
              const r = await previewImport(text);
              if (!r.ok) setNotice(r.message);
              else {
                setMapping(r.preview.mapping);
                setPreview(r.preview);
              }
            });
          }}
        />
      </label>
      {preview && (
        <>
          <h2 className="font-semibold">Match columns</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(fields).map(([key, label]) => (
              <label key={key}>
                {label}
                <select
                  className="ml-2 rounded border p-2"
                  disabled={pending}
                  value={mapping[key] ?? ""}
                  onChange={(e) => {
                    setReviewed(false);
                    setMapping((old) => {
                      const next = { ...old };
                      if (e.target.value) next[key] = e.target.value;
                      else delete next[key];
                      return next;
                    });
                  }}
                >
                  <option value="">Do not import</option>
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="rounded border px-3 py-2"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await previewImport(csv, mapping);
                if (!r.ok) setNotice(r.message);
                else {
                  setPreview(r.preview);
                  setReviewed(true);
                  setNotice("");
                }
              })
            }
          >
            Review mapped rows
          </button>
          {reviewed && (
            <>
              <p>
                {preview.totalRows} rows: {preview.validRows} valid,{" "}
                {preview.invalidRows} need correction.
              </p>
              <div className="overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Name</th>
                      <th>Phone</th>
                      <th>Email</th>
                      <th>Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="p-2">{row.rowNumber}</td>
                        <td>
                          {[row.values.firstName, row.values.lastName]
                            .filter(Boolean)
                            .join(" ")}
                        </td>
                        <td>{row.values.phone}</td>
                        <td>{row.values.email}</td>
                        <td>{row.valid ? "Ready" : row.errors.join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm">
                Preview shows the first 20 rows. Importing does not grant
                marketing consent.
              </p>
              {preview.invalidRows > 0 && (
                <label className="block">
                  <input
                    type="checkbox"
                    checked={skip}
                    onChange={(e) => setSkip(e.target.checked)}
                  />{" "}
                  Skip invalid rows and import valid rows only
                </label>
              )}
              <button
                type="button"
                className="rounded border px-3 py-2"
                disabled={
                  pending ||
                  !preview.validRows ||
                  (preview.invalidRows > 0 && !skip)
                }
                onClick={() => {
                  if (
                    !confirm(
                      `Import ${preview.validRows} valid rows? Existing submissions from this file will be skipped.`,
                    )
                  )
                    return;
                  start(async () => {
                    const r = await commitImport(csv, mapping, skip);
                    if (!r.ok) setNotice(r.message);
                    else {
                      setNotice(
                        `Import finished: ${r.result.created} created, ${r.result.duplicates} duplicates skipped, ${r.result.failed} failed. ${r.result.failures.map((f) => `Row ${f.rowNumber}: ${f.reason}`).join("; ")}`,
                      );
                      setReviewed(false);
                    }
                  });
                }}
              >
                Confirm import
              </button>
            </>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="rounded border p-3">
          {notice}
        </p>
      )}
      <Link className="block text-brand" href="/leads">
        View inquiries
      </Link>
    </div>
  );
}
