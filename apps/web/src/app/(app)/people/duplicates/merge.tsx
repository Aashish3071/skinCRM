"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import type { PersonDto } from "@skincrm/contracts";
import { Badge, Card } from "@/components/ui";
import { mergePeopleAction, type ActionState } from "@/lib/crm-actions";

/**
 * One group of possible duplicates. The user picks which record survives; the
 * other is folded into it and kept, pointing at the survivor, so the merge can
 * be reversed (PRD ID-06).
 */
export function MergeGroup({ matchedOn, people }: { matchedOn: string; people: PersonDto[] }) {
  const [state, action] = useActionState(mergePeopleAction, { status: "idle" } as ActionState);
  const [survivingId, setSurvivingId] = useState(people[0]?.id ?? "");

  const merged = state.status === "success";

  return (
    <Card
      title={`Matched on ${matchedOn}`}
      description={`${people.length} records share the same ${matchedOn}.`}
    >
      {merged ? (
        <p role="status" className="text-sm text-positive">
          {state.message}
        </p>
      ) : (
        <form action={action} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Which record should be kept?</legend>
            {people.map((person) => (
              <label
                key={person.id}
                className="flex items-start gap-3 rounded-md border border-line-strong px-3 py-2.5 text-sm"
              >
                <input
                  type="radio"
                  name="survivingPersonId"
                  value={person.id}
                  checked={survivingId === person.id}
                  onChange={() => setSurvivingId(person.id)}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="font-medium">{person.displayName}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {person.phone ?? "no phone"} · {person.email ?? "no email"}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-subtle">
                    Added {new Date(person.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <Link
                  href={`/people/${person.id}`}
                  className="shrink-0 text-xs text-brand"
                  target="_blank"
                >
                  Open
                </Link>
              </label>
            ))}
          </fieldset>

          {/* Only two-way merges here. With three or more, merging in pairs keeps
              each step reversible and each decision explicit. */}
          <input
            type="hidden"
            name="mergedPersonId"
            value={people.find((p) => p.id !== survivingId)?.id ?? ""}
          />

          <div className="flex flex-col gap-1">
            <label htmlFor="reason" className="text-xs font-medium text-ink-muted">
              Reason (recorded in the audit trail)
            </label>
            <input
              id="reason"
              name="reason"
              placeholder="Same person, called twice"
              className="w-full max-w-md rounded-md border border-line-strong bg-surface px-3 py-2 text-sm"
            />
          </div>

          <div className="flex items-center gap-3">
            <Submit />
            <p className="text-xs text-ink-subtle">
              Notes, inquiries, tasks and consent move to the kept record. This can be undone.
            </p>
          </div>

          {state.status === "error" && (
            <p role="alert" className="text-sm text-critical">
              {state.message}
            </p>
          )}
        </form>
      )}
    </Card>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
    >
      {pending ? "Merging…" : "Merge records"}
    </button>
  );
}
