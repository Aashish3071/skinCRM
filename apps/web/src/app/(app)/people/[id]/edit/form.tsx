"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { PersonDto } from "@skincrm/contracts";
import { Card, Field, buttonClasses, inputClasses } from "@/components/ui";
import { updatePersonAction, type ActionState } from "@/lib/crm-actions";
import { EmailInput, NameInput, PhoneInput } from "@/components/contact-inputs";

const idle: ActionState = { status: "idle" };

export function PersonEditForm({ person, branches }: { person: PersonDto; branches: { id: string; name: string }[] | null }) {
  const [state, action] = useActionState(updatePersonAction, idle);
  const errors = state.status === "error" ? state.fieldErrors : undefined;
  // After a rejected save, show what was typed rather than the stored values.
  const kept = state.status === "error" ? state.values : undefined;
  const v = (key: keyof PersonDto & string) => kept?.[key] ?? (person[key] as string | null) ?? "";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="max-w-3xl space-y-5">
      <input type="hidden" name="personId" value={person.id} />
      <div key={JSON.stringify(kept ?? {})} className="space-y-5">
      <Card title="Name and contact">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="firstName" errors={errors?.firstName}><NameInput id="firstName" name="firstName" autoComplete="given-name" defaultValue={v("firstName")} /></Field>
          <Field label="Last name" htmlFor="lastName" errors={errors?.lastName}><NameInput id="lastName" name="lastName" autoComplete="family-name" defaultValue={v("lastName")} /></Field>
          <Field label="Phone" htmlFor="phone" errors={errors?.phone}><PhoneInput id="phone" name="phone" defaultValue={v("phone")} /></Field>
          <Field label="Email" htmlFor="email" errors={errors?.email}><EmailInput id="email" name="email" defaultValue={v("email")} /></Field>
        </div>
        <p className="mt-3 text-xs text-ink-subtle">Keep at least a phone number or an email address.</p>
      </Card>
      <Card title="Preferences">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Preferred contact" htmlFor="preferredContactMethod" errors={errors?.preferredContactMethod}>
            <select id="preferredContactMethod" name="preferredContactMethod" defaultValue={v("preferredContactMethod")} className={inputClasses}>
              <option value="">No preference</option><option value="phone">Phone</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option>
            </select>
          </Field>
          <Field label="Preferred language" htmlFor="preferredLanguage" errors={errors?.preferredLanguage}><input id="preferredLanguage" name="preferredLanguage" defaultValue={v("preferredLanguage")} maxLength={60} placeholder="e.g. Spanish" className={inputClasses} /></Field>
          <Field label="Date of birth" htmlFor="dateOfBirth" errors={errors?.dateOfBirth}><input id="dateOfBirth" name="dateOfBirth" type="date" min="1900-01-01" max={today} defaultValue={v("dateOfBirth")} className={inputClasses} /></Field>
          {branches && <Field label="Branch" htmlFor="branchId" errors={errors?.branchId}>
            <select id="branchId" name="branchId" defaultValue={v("branchId")} className={inputClasses}>
              <option value="">No branch</option>
              {person.branchId && !branches.some((branch) => branch.id === person.branchId) && <option value={person.branchId}>Current branch (archived)</option>}
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </Field>}
        </div>
      </Card>
      <Card title="Address">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Address line 1" htmlFor="addressLine1" errors={errors?.addressLine1}><input id="addressLine1" name="addressLine1" defaultValue={v("addressLine1")} autoComplete="address-line1" maxLength={200} className={inputClasses} /></Field></div>
          <div className="sm:col-span-2"><Field label="Address line 2" htmlFor="addressLine2" errors={errors?.addressLine2}><input id="addressLine2" name="addressLine2" defaultValue={v("addressLine2")} autoComplete="address-line2" maxLength={200} className={inputClasses} /></Field></div>
          <Field label="City" htmlFor="city" errors={errors?.city}><input id="city" name="city" defaultValue={v("city")} autoComplete="address-level2" maxLength={120} className={inputClasses} /></Field>
          <Field label="State / region" htmlFor="region" errors={errors?.region}><input id="region" name="region" defaultValue={v("region")} autoComplete="address-level1" maxLength={120} className={inputClasses} /></Field>
          <Field label="Postal code" htmlFor="postalCode" errors={errors?.postalCode}><input id="postalCode" name="postalCode" defaultValue={v("postalCode")} autoComplete="postal-code" maxLength={20} className={inputClasses} /></Field>
        </div>
      </Card>
      </div>
      {state.status === "error" && <p role="alert" className="text-sm text-critical">{state.message}</p>}
      <div className="flex flex-wrap gap-3"><SaveButton /><Link href={`/people/${person.id}`} className={buttonClasses("secondary")}>Cancel</Link></div>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className={buttonClasses()}>{pending ? "Saving…" : "Save changes"}</button>;
}
