"use client";

import { useId, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PersonPicker, type PickedPerson } from "./person-picker";
import { SearchIcon, XIcon } from "./icons";
import { buttonClasses, inputClasses } from "./ui";

export interface FilterSelect {
  name: string;
  label: string;
  value: string;
  /** The first option is the "no filter" choice and is left out of the URL. */
  options: { value: string; label: string }[];
}

export interface FeedFilterValues {
  search?: string;
  patient: PickedPerson | null;
  selects: FilterSelect[];
  from: string;
  to: string;
  groupBy: FilterSelect;
}

/**
 * One filter panel for the Notes and Activity feeds, laid out the same way on
 * both: what to look for on top, the narrowing choices in one row, then one
 * Apply button. Nothing changes until Apply (or Enter), so a half-typed date
 * never reloads the page, and every filter lives in the URL so a filtered view
 * can be bookmarked or shared.
 *
 * Active filters are repeated below as removable chips, and the result count
 * is announced to screen readers after each change.
 */
export function FeedFilters({
  values,
  searchLabel,
  resultLabel,
}: {
  values: FeedFilterValues;
  searchLabel?: string;
  resultLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const [patient, setPatient] = useState<PickedPerson | null>(values.patient);
  const [dateError, setDateError] = useState<string | null>(null);
  // On a phone the panel starts folded so the results are on the first screen.
  const [open, setOpen] = useState(false);

  const push = (params: Record<string, string>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
    router.push(`${pathname}${query.size ? `?${query}` : ""}`);
  };

  /** The current URL state, as a plain object, for chip removal. */
  const current = (): Record<string, string> => {
    const state: Record<string, string> = {};
    if (values.search) state.search = values.search;
    if (values.patient) {
      state.personId = values.patient.id;
      state.personName = values.patient.name;
    }
    for (const select of values.selects) if (select.value !== select.options[0]!.value) state[select.name] = select.value;
    if (values.from) state.from = values.from;
    if (values.to) state.to = values.to;
    if (values.groupBy.value !== values.groupBy.options[0]!.value) state[values.groupBy.name] = values.groupBy.value;
    return state;
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = String(data.get("from") ?? "");
    const to = String(data.get("to") ?? "");
    if (from && to && from > to) {
      setDateError("The end date is before the start date.");
      return;
    }
    setDateError(null);
    const next: Record<string, string> = {};
    const search = String(data.get("search") ?? "").trim();
    if (search) next.search = search;
    if (patient) {
      next.personId = patient.id;
      next.personName = patient.name;
    }
    for (const select of [...values.selects, values.groupBy]) {
      const value = String(data.get(select.name) ?? "");
      if (value !== select.options[0]!.value) next[select.name] = value;
    }
    if (from) next.from = from;
    if (to) next.to = to;
    push(next);
  };

  const chips: { key: string; label: string; remove: string[] }[] = [];
  if (values.search) chips.push({ key: "search", label: `“${values.search}”`, remove: ["search"] });
  if (values.patient) chips.push({ key: "patient", label: values.patient.name, remove: ["personId", "personName"] });
  for (const select of values.selects) {
    if (select.value === select.options[0]!.value) continue;
    const option = select.options.find((o) => o.value === select.value);
    if (option) chips.push({ key: select.name, label: option.label, remove: [select.name] });
  }
  if (values.from || values.to) {
    const label = values.from && values.to
      ? values.from === values.to ? formatDay(values.from) : `${formatDay(values.from)} – ${formatDay(values.to)}`
      : values.from ? `From ${formatDay(values.from)}` : `Until ${formatDay(values.to)}`;
    chips.push({ key: "dates", label, remove: ["from", "to"] });
  }

  const removeChip = (keys: string[]) => {
    const state = current();
    for (const key of keys) delete state[key];
    if (keys.includes("personId")) setPatient(null);
    push(state);
  };

  const groupBy = values.groupBy;
  const dateHint = `${id}-date-error`;

  return (
    <section aria-label="Filters" className="mb-5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        className={`${buttonClasses("secondary")} mb-3 w-full justify-between sm:hidden`}
      >
        <span>Filters{chips.length > 0 ? ` (${chips.length} on)` : ""}</span>
        <span aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>
      <form
        id={`${id}-panel`}
        onSubmit={submit}
        // Remounting on URL change keeps the uncontrolled inputs in step with
        // chip removals and back/forward navigation.
        key={JSON.stringify(current())}
        className={`${open ? "block" : "hidden"} rounded-card border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:block`}
      >
        <div className={`grid gap-4 ${values.search !== undefined ? "md:grid-cols-2" : ""}`}>
          {values.search !== undefined && (
            <div>
              <label htmlFor={`${id}-search`} className="block text-sm font-medium">{searchLabel ?? "Search"}</label>
              <div className="relative mt-1.5">
                <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                <input id={`${id}-search`} name="search" type="search" defaultValue={values.search} placeholder="Words in the note or a patient’s name" className={`${inputClasses} pl-9`} />
              </div>
            </div>
          )}
          <PersonPicker label="Patient" placeholder="Any patient — type a name, phone or email" value={patient} onChange={setPatient} />
        </div>

        <div className={`mt-4 grid grid-cols-2 gap-4 ${values.selects.length > 1 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
          {values.selects.map((select) => (
            <div key={select.name} className="col-span-2 sm:col-span-1">
              <label htmlFor={`${id}-${select.name}`} className="block text-sm font-medium">{select.label}</label>
              <select id={`${id}-${select.name}`} name={select.name} defaultValue={select.value} className={`mt-1.5 ${inputClasses}`}>
                {select.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          ))}
          <div>
            <label htmlFor={`${id}-from`} className="block text-sm font-medium">From date</label>
            <input id={`${id}-from`} name="from" type="date" defaultValue={values.from} aria-invalid={dateError ? true : undefined} aria-describedby={dateError ? dateHint : undefined} className={`mt-1.5 ${inputClasses}`} />
          </div>
          <div>
            <label htmlFor={`${id}-to`} className="block text-sm font-medium">To date</label>
            <input id={`${id}-to`} name="to" type="date" defaultValue={values.to} aria-invalid={dateError ? true : undefined} aria-describedby={dateError ? dateHint : undefined} className={`mt-1.5 ${inputClasses}`} />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label htmlFor={`${id}-${groupBy.name}`} className="block text-sm font-medium">{groupBy.label}</label>
            <select id={`${id}-${groupBy.name}`} name={groupBy.name} defaultValue={groupBy.value} className={`mt-1.5 ${inputClasses}`}>
              {groupBy.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        </div>
        {dateError && <p id={dateHint} role="alert" className="mt-2 text-sm text-critical">{dateError}</p>}
        <p className="mt-2 text-xs text-ink-subtle">Dates are whole days in the clinic’s time zone. Leave either blank for no limit.</p>

        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {chips.length > 0 && <button type="button" onClick={() => { setPatient(null); push(groupBy.value !== groupBy.options[0]!.value ? { [groupBy.name]: groupBy.value } : {}); }} className={buttonClasses("ghost")}>Clear all filters</button>}
          <button type="submit" className={buttonClasses()}>Apply filters</button>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <p aria-live="polite" className="text-ink-muted">{resultLabel}</p>
        {chips.length > 0 && (
          <ul aria-label="Active filters" className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <li key={chip.key}>
                <button
                  type="button"
                  onClick={() => removeChip(chip.remove)}
                  aria-label={`Remove filter: ${chip.label}`}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-brand bg-brand-soft px-3 text-[13px] font-medium text-brand hover:bg-surface"
                >
                  {chip.label}
                  <XIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function formatDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
