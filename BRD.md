# Clinic Lead & Appointment CRM — Business Requirements Document

**Version:** 1.0 draft  
**Date:** 25 September 2026  
**Owner:** Clinic sponsor (to confirm)  
**Audience:** Clinic owner, front desk, marketing, implementation team

## 1. Executive summary

Build a CRM that captures inquiries from Meta lead forms, **click-to-WhatsApp ads and other WhatsApp conversations**, Google Ads lead forms, website forms, and walk-ins; assigns them to clinic staff; tracks each inquiry through consultation and conversion; schedules appointments and follow-ups; and sends consent-aware email and WhatsApp messages. Staff should manage WhatsApp conversations and leads from the CRM's shared inbox. The clinic should be able to see which sources produce appointments and paying customers.

The first release is a **lead and appointment CRM**, not an electronic medical record. It includes a **General Notes** section on each person record so staff can remember useful context such as contact preferences, availability, language, and past conversation details. The requester has confirmed that it will contain no prescriptions, medical advice, diagnoses, photos, or treatment notes. It may record a broad service interest for staff use; notes and service/condition details are excluded from ad-platform feedback.

## 2. Business context and assumptions

The clinic currently needs one place to manage incoming inquiries and follow-up work. Staff may otherwise lose leads between ad platforms, spreadsheets, inboxes, and personal calendars. The clinic operates in **Florida, United States**. Its specialty, number of branches, staff count, and existing systems are not yet confirmed. Requirements below support one clinic initially and allow multiple branches later.

**Assumptions to validate before build:**

- The clinic owns or has authorized access to its Meta Page/lead forms, WhatsApp Business mobile-app number, and Google Ads account.
- Email and WhatsApp are first-release channels. WhatsApp requires an authorized WhatsApp Business Platform account/number, approved templates when applicable, channel-specific consent, and clinic-approved messaging policy. SMS remains a later option.
- The CRM handles consultation booking, not doctor availability or treatment-room scheduling unless requested.
- Users include owner/admin, front desk or counselor, practitioner, and marketing viewer.
- A customer can submit multiple inquiries over time; one person record can have several lead opportunities and appointments.

## 3. Business objectives and measures

| Objective | Proposed measure | Initial target to agree with clinic |
|---|---|---|
| Prevent lead loss | Captured leads with source and owner | ≥ 98% of supported source submissions appear or trigger an integration alert |
| Improve response speed | Median time from lead arrival to first human contact | Set baseline in first 2 weeks; then improve by 30% |
| Improve booking | Qualified leads booked for consultation | Baseline first month; then monthly target |
| Reduce no-shows | Appointment attendance rate | Baseline first month; then monthly target |
| Show marketing value | Leads, bookings, attended visits, conversions by source/campaign | Available in dashboard and CSV export |
| Protect client trust | Unauthorized access and unwanted automated sends | Zero known incidents; opt-outs honored before future sends |

Targets are planning proposals, not clinic commitments.

## 4. Stakeholders and users

| Role | Need |
|---|---|
| Clinic owner/admin | See funnel performance, manage users, integrations, templates, rules, and data settings |
| Front desk/counselor | Capture walk-ins, call leads, update stages, book visits, and complete follow-up tasks |
| Practitioner | See assigned appointments and limited client context relevant to the visit |
| Marketing user | See source and campaign performance without unrestricted access to personal details |
| Client/prospect | Receive timely, relevant contact and booking details; be able to opt out |

## 5. Scope and priorities

### Must have for MVP

1. Secure login and role-based access.
2. Lead creation from walk-in/manual entry, CSV import, website form/API, Meta lead forms, click-to-WhatsApp ads/WhatsApp inbound conversations, and Google Ads lead-form webhooks.
3. Contact matching and duplicate review; preserve every source submission.
4. Configurable lead pipeline, ownership, activity timeline, next action, and loss reasons; a dedicated General Notes section on each person record plus inquiry-specific notes on leads.
5. Calendar with staff availability, appointment booking, rescheduling, cancellation, status, and reminders.
6. Email and WhatsApp templates and rule-based follow-up with consent, suppression, pause, and audit history.
7. Task list, overdue alerts, and dashboard for source-to-booking performance.
8. Shared WhatsApp inbox with conversation assignment, reply, contact/lead linking, status and follow-up tasks.
9. Controlled conversion-feedback integration for Meta and Google Ads: map approved CRM milestones such as Qualified and Consultation booked to platform events, with a preview, policy gate, delivery log and pause switch.
10. Integration health, failed-event replay, basic exports, and audit log.

### Should have after MVP

- Self-service booking link and appointment confirmation/reschedule link.
- Two-way calendar sync with the clinic's chosen calendar provider.
- Branch-level permissions and resource/room availability.
- Feedback/review request after an attended appointment, with consent and frequency limits.
- More detailed conversion and revenue attribution, if the clinic records payments in the CRM or connects billing.

### Future options requiring separate discovery

- SMS messaging; call-center or telephony integration.
- Treatment plans, case history, consent forms, before/after photos, prescriptions, and clinical documentation.
- Invoicing, payments, packages, memberships, inventory, and referral rewards.
- Ad spend ingestion and campaign ROI.
- AI lead summaries or suggested responses, subject to privacy review and human approval.

## 6. Desired business process

1. **Capture:** A prospect submits an ad/website form, messages the clinic on WhatsApp, or walks in. The CRM records submission time, source, form/campaign or WhatsApp referral identifiers when present, contact details, service interest, and consent evidence.
2. **Normalize and match:** The CRM creates an inquiry and links it to an existing person when there is a reliable phone/email match. Ambiguous matches go to staff review. No submission silently disappears.
3. **Assign:** Rules route the inquiry to a staff member or queue by source, service, branch, and availability. An unassigned lead is visible to the front desk.
4. **Respond:** Staff contact the prospect from the appropriate channel, record outcome, and set the next task. A permitted acknowledgment email or WhatsApp message may go out automatically.
5. **Qualify:** Staff determine interest, timing, and preferred consultation slot. They can mark invalid/unreachable leads with a reason.
6. **Book and attend:** Staff schedule the appointment, send confirmations/reminders where allowed, and mark attended, no-show, or canceled.
7. **Close:** Staff mark outcome as converted, lost, or nurture. The original source remains available for reporting.

**Suggested default pipeline:** New → Attempting contact → Connected → Qualified → Consultation booked → Consultation attended → Converted. Side exits: Unqualified, Lost, Duplicate, and Nurture. Appointment status is a separate concept; changing an appointment must not silently overwrite the lead's stage.

## 7. Business rules

- Every lead must have a source, created timestamp, current stage, and owner or unassigned queue.
- Source and external submission ID are immutable after ingestion; users may add a corrected reporting source with an audit record.
- One person may have multiple inquiries. Merging people must preserve all submissions, notes, tasks, appointments, and message history.
- General Notes belong to the person and remain visible across that person's inquiries. Each note records author and time; staff can edit or archive with an audit trail. Notes are internal staff context and never included in automated messages or ad-platform feedback.
- A contact may have different permissions for email versus WhatsApp and for operational appointment messages versus promotional/nurture messages. The clinic must approve consent wording and permitted contact basis for its jurisdiction.
- No promotional automation starts without a valid opt-in or another clinic-approved lawful basis. An unsubscribe/suppression event blocks subsequent promotional sends. WhatsApp business-initiated messages must follow Meta's template and messaging-window rules.
- Automations stop or change when a lead replies, books, converts, opts out, or is closed, according to the rule definition.
- Staff can override assignment, stage, and automation enrollment; the change is logged.
- Deleted/archived records remain recoverable for a configurable period unless a valid deletion request requires removal.
- Reports distinguish lead count, unique people, bookings, attended appointments, and conversions.
- The clinic defines what makes a lead **Qualified** using observable criteria; the CRM records who qualified it and when. The requester has confirmed lead-stage conversion feedback as a product requirement. Eligible milestones create an outbound candidate; the production connector sends only after the exact event and identifier pass the destination's current policy and account checks.
- Conversion feedback is one-way from CRM to an approved ad account; inbound lead ingestion does not itself tell an ad platform that a lead qualified. Unmatched or rejected events remain visible in the CRM and must not be counted as platform-reported conversions.

## 8. Reporting requirements

Dashboard filters: date range, source, campaign/form, service, branch, owner, and lead stage. Show lead volume, response time, contact rate, booking rate, attendance/no-show rate, conversion rate, aging, overdue tasks, and integration failures. Export filtered reports as CSV. Make the attribution rule visible: **first inquiry source**, **latest inquiry source**, or **source of the converted inquiry**. Default to source of the converted inquiry and show it consistently.

## 9. Nonfunctional and trust requirements

- Responsive web app that works on front-desk desktop and mobile browser.
- Timezone-aware appointment handling; store timestamps in UTC and display clinic timezone.
- Encrypt traffic and stored sensitive data; keep provider secrets outside source code; rotate and revoke credentials.
- Enforce least-privilege roles and log access to records, exports, merges, messages, and settings changes.
- Keep message content free of sensitive health details by default. Avoid exposing service/condition in subject lines or calendar titles unless the clinic approves it.
- Provide retention, export, deletion, and consent-history controls based on the clinic's jurisdiction and approved policy.
- Show integration health, retry failures safely, and alert staff when lead ingestion stalls.
- Backups, restore procedure, and production monitoring are required before launch.
- Set concrete uptime, data retention, recovery, and support targets in the delivery agreement.

## 10. Dependencies, risks, and decisions

| Item | Effect | Decision/mitigation |
|---|---|---|
| Meta permissions and Page access | Direct lead retrieval may require app review and clinic authorization | Validate access early; support CSV/manual import during approval |
| WhatsApp account/number setup | The clinic currently uses the WhatsApp Business mobile app; connecting its existing number to the Platform may require a supported coexistence/onboarding path, and access/history behavior can vary | Validate eligibility and complete a pilot on the existing number before any migration or cutover; preserve the app workflow unless the clinic approves a change |
| WhatsApp messaging and healthcare privacy | Templates, 24-hour service window, consent and potentially sensitive conversation content affect operation | Approve workflow, vendor/BAA status, message content and retention before live messaging |
| Ad-platform feedback and health data | Even lead-only qualification or booking can reveal a clinic relationship; Google restricts enhanced conversions for health/medical categories and Meta restricts sensitive business-tool data | Implement the requested feedback feature; before production activation, verify each proposed event and identifier against platform policy/account restrictions. Use CRM-only reporting if a signal is ineligible |
| Google lead-form setup | Each form needs webhook configuration and a validation secret | Test each form, store mapping, and monitor delivery |
| US/Florida privacy and marketing rules | Determines consent, retention, message content, and subject rights | Clinic counsel/privacy lead determines HIPAA status, approved vendors and policy before live sending |
| Existing calendar/email system | Affects sync and sender authentication | Select provider and domain during implementation planning |
| Duplicate or incomplete source data | May skew follow-up and reports | Retain raw submission, normalize fields, offer review queue |
| Scope creep into patient records | Changes security and operational obligations | Keep clinical module out of MVP pending separate requirements |

**Open decisions for sponsor:** clinic specialty and services advertised; the objective criteria for Qualified; one or multiple branches; staff roles and volumes; exact pipeline stages; consultation types/durations; current email/calendar providers; ownership/admin access for the existing WhatsApp Business mobile-app number and Meta Business portfolio; consent wording and privacy policy; preferred hosting and data region; HIPAA covered-entity status and vendor BAAs; which CRM milestones and identifiers, if any, each ad platform permits; whether payments or treatment history are needed later.

## 11. Business acceptance and launch criteria

- Staff can capture a walk-in and process a Meta, Google, website, and WhatsApp ad test lead end to end.
- Staff can receive and reply to a WhatsApp conversation in the CRM, assign it, link it to a person/lead, and book an appointment.
- Duplicate submissions do not create duplicate source events or lose details.
- A lead can be assigned, contacted, booked, attended, and converted with a visible timeline.
- Email rules respect consent and opt-out; every send has a status and reason.
- Appointment conflicts are prevented or explicitly resolved; cancellation/reschedule updates reminders.
- Owner can view the funnel by source and export a matching CSV.
- Admin can inspect which CRM milestones will be sent to each platform, see transmitted/accepted/rejected/suppressed status, and stop outbound feedback instantly; live sending starts after the platform-specific eligibility checks pass.
- Failed integrations and undelivered messages are visible to an admin with a retry path.
- Clinic signs off on privacy, retention, roles, sender domain, and real account connection before production launch.

## 12. Implementation phases

1. **Discovery and design:** Confirm open decisions; map clinic workflow and forms; obtain provider access; approve data policy.
2. **Core CRM:** People, leads, pipeline, tasks, permissions, calendar, reporting, manual/CSV/website intake.
3. **Communications:** Email and WhatsApp delivery, shared inbox, templates, consent management, automations, and reminders.
4. **Ad integrations:** Meta lead forms, click-to-WhatsApp, and Google lead forms; test submissions, monitoring, replay, source attribution, and policy-gated conversion feedback.
5. **Pilot and launch:** Import data, train staff, run parallel process, validate metrics, then launch.

## 13. External integration references

- [Meta Lead Ads lead retrieval documentation](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/) and [webhook integration](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration). Confirm current access requirements in the clinic's Meta app and Page during implementation.
- [Google Ads lead-form webhook overview](https://developers.google.com/google-ads/webhook/docs/overview), [payload and deduplication guidance](https://developers.google.com/google-ads/webhook/docs/implementation), and [test procedure](https://developers.google.com/google-ads/webhook/docs/testing).
- [HHS guidance on HIPAA and cloud providers](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html), [HHS guidance on marketing](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/marketing/index.html), [FTC CAN-SPAM guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business), and [Florida Statutes §501.171](https://www.flsenate.gov/Laws/Statutes/2026/501.171). These sources inform requirements; the clinic must obtain its own compliance assessment.
- [Meta's official WhatsApp Business Platform collection](https://www.postman.com/meta/whatsapp-business-platform/overview), [Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/collection/du6gzjv/embedded-signup), and [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy).
- [Meta's lead-generation guide describing CRM conversion feedback](https://about.fb.com/ltam/wp-content/uploads/sites/14/2023/11/LeadGenerationGuide.pdf); [Google's Data Manager API event upload guide](https://developers.google.com/data-manager/api/devguides/events/send-events), [Google customer-data policy](https://support.google.com/adspolicy/answer/7475709?hl=en), and [Google restricted targeting policy](https://support.google.com/adspolicy/answer/143465?hl=en).
