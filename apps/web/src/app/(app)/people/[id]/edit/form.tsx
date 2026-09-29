"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { PersonDto } from "@skincrm/contracts";
import { Card, Field, buttonClasses, inputClasses } from "@/components/ui";
import { updatePersonAction, type ActionState } from "@/lib/crm-actions";

const idle: ActionState = { status: "idle" };

export function PersonEditForm({ person, branches }: { person: PersonDto; branches: { id: string; name: string }[] | null }) {
  const [state, action] = useActionState(updatePersonAction, idle);
  const errors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <form action={action} className="max-w-3xl space-y-5">
      <input type="hidden" name="personId" value={person.id} />
      <Card title="Name and contact">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="firstName" errors={errors?.firstName}><input id="firstName" name="firstName" defaultValue={person.firstName ?? ""} className={inputClasses} /></Field>
          <Field label="Last name" htmlFor="lastName" errors={errors?.lastName}><input id="lastName" name="lastName" defaultValue={person.lastName ?? ""} className={inputClasses} /></Field>
          <Field label="Phone" htmlFor="phone" errors={errors?.phone}><input id="phone" name="phone" type="tel" defaultValue={person.phone ?? ""} maxLength={40} className={inputClasses} /></Field>
          <Field label="Email" htmlFor="email" errors={errors?.email}><input id="email" name="email" type="email" defaultValue={person.email ?? ""} maxLength={320} className={inputClasses} /></Field>
        </div>
        <p className="mt-3 text-xs text-ink-subtle">Keep at least a phone number or an email address.</p>
      </Card>
      <Card title="Preferences">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Preferred contact" htmlFor="preferredContactMethod" errors={errors?.preferredContactMethod}>
            <select id="preferredContactMethod" name="preferredContactMethod" defaultValue={person.preferredContactMethod ?? ""} className={inputClasses}>
              <option value="">No preference</option><option value="phone">Phone</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option>
            </select>
          </Field>
          <Field label="Preferred language" htmlFor="preferredLanguage" errors={errors?.preferredLanguage}><input id="preferredLanguage" name="preferredLanguage" defaultValue={person.preferredLanguage ?? ""} maxLength={60} className={inputClasses} /></Field>
          <Field label="Date of birth" htmlFor="dateOfBirth" errors={errors?.dateOfBirth}><input id="dateOfBirth" name="dateOfBirth" type="date" defaultValue={person.dateOfBirth ?? ""} className={inputClasses} /></Field>
          {branches && <Field label="Branch" htmlFor="branchId" errors={errors?.branchId}>
            <select id="branchId" name="branchId" defaultValue={person.branchId ?? ""} className={inputClasses}>
              <option value="">No branch</option>
              {person.branchId && !branches.some((branch) => branch.id === person.branchId) && <option value={person.branchId}>Current branch (archived)</option>}
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </Field>}
        </div>
      </Card>
      <Card title="Address">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Address line 1" htmlFor="addressLine1" errors={errors?.addressLine1}><input id="addressLine1" name="addressLine1" defaultValue={person.addressLine1 ?? ""} maxLength={200} className={inputClasses} /></Field></div>
          <div className="sm:col-span-2"><Field label="Address line 2" htmlFor="addressLine2" errors={errors?.addressLine2}><input id="addressLine2" name="addressLine2" defaultValue={person.addressLine2 ?? ""} maxLength={200} className={inputClasses} /></Field></div>
          <Field label="City" htmlFor="city" errors={errors?.city}><input id="city" name="city" defaultValue={person.city ?? ""} maxLength={120} className={inputClasses} /></Field>
          <Field label="State / region" htmlFor="region" errors={errors?.region}><input id="region" name="region" defaultValue={person.region ?? ""} maxLength={120} className={inputClasses} /></Field>
          <Field label="Postal code" htmlFor="postalCode" errors={errors?.postalCode}><input id="postalCode" name="postalCode" defaultValue={person.postalCode ?? ""} maxLength={20} className={inputClasses} /></Field>
        </div>
      </Card>
      {state.status === "error" && <p role="alert" className="text-sm text-critical">{state.message}</p>}
      <div className="flex flex-wrap gap-3"><SaveButton /><Link href={`/people/${person.id}`} className={buttonClasses("secondary")}>Cancel</Link></div>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className={buttonClasses()}>{pending ? "Saving…" : "Save changes"}</button>;
}
