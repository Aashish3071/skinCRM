"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { searchPeopleAction } from "@/lib/crm-actions";
import { SearchIcon, XIcon } from "./icons";

export interface PickedPerson {
  id: string;
  name: string;
}

/**
 * "Who is this about?" — type a name, phone or email and pick from the list.
 *
 * An ARIA combobox: arrow keys move through results, Enter picks, Escape
 * closes. Once someone is chosen it shows as a single chip with a clear
 * button, so there is never doubt about which patient a note is going to.
 */
export function PersonPicker({
  value,
  onChange,
  label = "Patient",
  placeholder = "Type a name, phone or email",
}: {
  value: PickedPerson | null;
  onChange: (person: PickedPerson | null) => void;
  label?: string;
  placeholder?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; contact: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      startTransition(async () => {
        setResults(await searchPeopleAction(query));
        setActive(0);
        setOpen(true);
      });
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query]);

  const pick = (person: PickedPerson) => {
    onChange(person);
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  if (value) {
    return (
      <div>
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-1.5 inline-flex min-h-10 items-center gap-2 rounded-lg border border-brand bg-brand-soft pl-3 pr-1 text-sm font-medium text-brand">
          {value.name}
          <button type="button" onClick={() => onChange(null)} aria-label={`Change patient, currently ${value.name}`} className="rounded-md p-1.5 hover:bg-surface">
            <XIcon size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative mt-1.5">
        <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
        <input
          id={id}
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && results[active] ? `${id}-opt-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && open && results[active]) {
              e.preventDefault();
              pick(results[active]!);
            } else if (e.key === "Escape") setOpen(false);
          }}
          className="min-h-10 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-ink-subtle"
        />
      </div>
      {open && query.trim().length >= 2 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-[var(--shadow-pop)]"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-muted">{pending ? "Searching…" : "Nobody found"}</li>
          ) : (
            results.map((r, i) => (
              <li
                key={r.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick({ id: r.id, name: r.name });
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer rounded-md px-3 py-2 text-sm ${i === active ? "bg-brand-soft text-brand" : ""}`}
              >
                <span className="font-medium">{r.name}</span>
                {r.contact && <span className="ml-2 text-xs text-ink-muted">{r.contact}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
