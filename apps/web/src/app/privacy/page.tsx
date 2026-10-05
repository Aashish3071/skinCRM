import { LegalPage, legalEntity } from "@/components/legal";

export const metadata = { title: "Privacy — SkinCRM" };

/**
 * Plain-language privacy notice. It describes what the software actually does
 * (see ARCHITECTURE.md and docs/INTEGRATION_SYNC.md); have counsel review it,
 * and the clinic's own notice to patients, before launch.
 */
export default function PrivacyPage() {
  const e = legalEntity();
  return (
    <LegalPage title="Privacy notice">
      <section>
        <h2>Who we are</h2>
        <p>
          SkinCRM is lead, patient-contact and appointment software that {e.name} provides to clinics. Each clinic decides what
          information it keeps about its patients and inquiries and is responsible for its own patient notice; SkinCRM processes
          that information on the clinic&rsquo;s behalf.
        </p>
      </section>
      <section>
        <h2>What is stored</h2>
        <ul>
          <li>Contact details: name, phone, email, postal address, preferred language and contact method.</li>
          <li>Inquiries and appointments: where an inquiry came from, its stage, booked times and the clinic team&rsquo;s notes.</li>
          <li>Messages: emails and WhatsApp messages sent and received through the clinic&rsquo;s connected accounts.</li>
          <li>Consent and opt-outs: what a person agreed to, when, and any request to stop messages.</li>
          <li>Staff accounts: name, email, role, sign-in history and actions in the audit log.</li>
        </ul>
        <p>SkinCRM is not a medical record system and is not designed to hold clinical notes or treatment records.</p>
      </section>
      <section>
        <h2>How it is used</h2>
        <ul>
          <li>To answer inquiries, book and remind appointments, and keep the clinic&rsquo;s team organised.</li>
          <li>To send messages only within each person&rsquo;s recorded consent, outside quiet hours, and never after an opt-out.</li>
          <li>When a clinic switches it on, to tell its advertising accounts (Meta, Google) that an ad inquiry reached a milestone such as a booking, using the platform&rsquo;s own click or lead identifier — never names, conditions or notes.</li>
          <li>When a clinic switches it on, to share hashed (scrambled) email addresses and phone numbers of people who agreed to marketing with its advertising accounts, so ads can reach or exclude them.</li>
        </ul>
      </section>
      <section>
        <h2>Who it is shared with</h2>
        <p>
          Only the service providers needed to run the software — hosting, email delivery (Postmark), messaging (WhatsApp by Meta),
          calendars (Google, Microsoft) and the advertising platforms the clinic connects. Information is not sold.
        </p>
      </section>
      <section>
        <h2>Security and retention</h2>
        <p>
          Each clinic&rsquo;s data is kept separate at the database level. Connected-account credentials are encrypted. Raw provider
          payloads are deleted after the retention period; patient records are kept until the clinic deletes them.
        </p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>
          To see, correct or delete information a clinic holds about you, or to stop messages, contact the clinic directly — every
          marketing email also has an unsubscribe link, and replying STOP on WhatsApp works too. Questions about SkinCRM itself:{" "}
          <a href={`mailto:${e.email}`} className="text-brand">{e.email}</a>, {e.address}.
        </p>
      </section>
    </LegalPage>
  );
}
