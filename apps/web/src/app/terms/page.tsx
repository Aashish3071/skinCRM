import { LegalPage, legalEntity } from "@/components/legal";

export const metadata = { title: "Terms — SkinCRM" };

/** Terms of use for clinic staff. Have counsel review before launch. */
export default function TermsPage() {
  const e = legalEntity();
  return (
    <LegalPage title="Terms of use">
      <section>
        <h2>Using SkinCRM</h2>
        <p>
          SkinCRM is provided by {e.name} to clinics under their agreement with us. These terms apply to everyone who signs in.
          Accounts are personal: do not share your password or two-step sign-in codes.
        </p>
      </section>
      <section>
        <h2>The clinic&rsquo;s responsibilities</h2>
        <ul>
          <li>Having a lawful basis and the consent it needs before messaging or advertising to people, including any audience it shares with advertising platforms.</li>
          <li>Keeping clinical or treatment details out of notes, messages and templates.</li>
          <li>Giving staff only the access their role needs, and removing it when they leave.</li>
          <li>Following the rules of the services it connects (Meta, WhatsApp, Google, Microsoft, Postmark).</li>
        </ul>
      </section>
      <section>
        <h2>What you must not do</h2>
        <ul>
          <li>Send spam, or messages to people who opted out.</li>
          <li>Try to reach another clinic&rsquo;s data or get around security controls.</li>
          <li>Upload content you have no right to use.</li>
        </ul>
      </section>
      <section>
        <h2>Availability and changes</h2>
        <p>
          We work to keep SkinCRM available and secure but cannot promise it will be uninterrupted. Connected services are run by
          third parties and may change or stop working. We may update these terms and will say so in the app.
        </p>
      </section>
      <section>
        <h2>Contact</h2>
        <p><a href={`mailto:${e.email}`} className="text-brand">{e.email}</a> · {e.address}</p>
      </section>
    </LegalPage>
  );
}
