"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PeopleSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // Kept in the URL so a search can be bookmarked and survives a refresh.
    router.push(value.trim() === "" ? "/people" : `/people?search=${encodeURIComponent(value.trim())}`);
  };

  return (
    <form onSubmit={submit} className="flex gap-2 rounded-card border border-line bg-surface px-4 py-3">
      <label htmlFor="people-search" className="sr-only">
        Search people
      </label>
      <input
        id="people-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Name, phone number or email"
        className="w-full max-w-sm rounded-md border border-line-strong bg-surface px-3 py-2 text-sm"
      />
      <button
        type="submit"
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-on-brand hover:bg-brand-hover"
      >
        Search
      </button>
      {initial && (
        <button
          type="button"
          onClick={() => {
            setValue("");
            router.push("/people");
          }}
          className="rounded-md border border-line-strong px-3 py-2 text-sm hover:bg-surface-muted"
        >
          Clear
        </button>
      )}
    </form>
  );
}
