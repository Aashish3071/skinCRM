"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PersonPicker, type PickedPerson } from "@/components/person-picker";

/** Narrow the feed to one patient. Lives in the URL, like every other filter. */
export function PatientFilter({ current }: { current: PickedPerson | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <PersonPicker
      label="Only for this patient"
      placeholder="Any patient — type to choose one"
      value={current}
      onChange={(person) => {
        const next = new URLSearchParams(params.toString());
        next.delete("count");
        if (person) {
          next.set("personId", person.id);
          next.set("personName", person.name);
        } else {
          next.delete("personId");
          next.delete("personName");
        }
        router.push(`${pathname}${next.size ? `?${next}` : ""}`);
      }}
    />
  );
}
