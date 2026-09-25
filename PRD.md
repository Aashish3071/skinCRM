# Clinic Lead & Appointment CRM — Product Requirements Document

**Version:** 1.0 draft  
**Date:** 25 September 2026  
**Market:** Florida, United States  
**Companion:** [BRD.md](BRD.md)  
**Build scope:** Lead management, shared WhatsApp inbox, booking, and lead-stage feedback to eligible ad platforms; no clinical charting or billing in MVP  
**Existing WhatsApp setup:** Clinic uses the WhatsApp Business mobile app and wants to keep its existing number
**Requester decision:** Lead-stage feedback to Meta and Google is a required product feature. The CRM has a General Notes section for staff to remember useful information about each person; it has no prescriptions, medical advice, diagnoses, photos, or treatment notes

## 1. Product goal

Give clinic staff one reliable workspace to capture every inquiry, manage WhatsApp conversations, follow up promptly, schedule consultations, and understand which channels turn into attended appointments. A user should be able to move a new walk-in, form lead, or WhatsApp ad conversation from capture to booked consultation without using a spreadsheet.

The implementation should be usable with sample data before real ad accounts or email credentials are connected. External integrations must be replaceable adapters, not hard-coded dependencies of the core CRM.

## 2. Actors and permissions

| Actor | Access in MVP |
|---|---|
| Admin/owner | All records, users, roles, pipeline, automations, integrations, exports, audit and settings |
| Front desk/counselor | Create and edit assigned/queue leads, contacts, tasks and appointments; send approved emails; limited export if admin enables it |
| Practitioner | Own calendar and minimum needed contact/appointment information; no campaign settings |
| Marketing analyst | Aggregate campaign dashboard; personal data hidden by default |

Enforce permissions in the API and database queries, not only in the interface. Seed one admin during setup. Record who changed a sensitive field and when.

## 3. Key user journeys

### J1 — Ad lead to consultation

1. Meta or Google sends a lead event.
2. Integration verifies it, stores the external event ID, and places an ingest job on a durable queue.
3. Normalization maps fields and source metadata. A matching person is linked or a new person is created.
4. A lead opportunity is created and assigned by routing rule. Staff see it in New and receive an in-app notification.
5. An approved acknowledgment email is scheduled if contact permissions allow it.
6. Staff call/email, record outcome, and book a consultation.
7. Confirmation and reminder jobs are created. Staff mark attended and converted or lost.

### J2 — Walk-in

Front desk creates a person and inquiry in one form, selects `Walk-in`, service interest, visit time, and consent evidence, then books immediately or adds a follow-up task. Entry should take under two minutes for a typical case.

### J2a — Click-to-WhatsApp ad to consultation

1. A prospect clicks the clinic's WhatsApp ad and sends a message to its business number.
2. The WhatsApp webhook creates or updates a conversation and person. It opens a lead opportunity if no suitable active opportunity exists.
3. The CRM stores referral/ad metadata **when present** and labels the inquiry as `WhatsApp ad` only when the metadata reliably identifies an ad; otherwise it is `WhatsApp organic` or `Unknown` until staff confirms the source with an audit trail.
4. The conversation appears in the shared inbox as unassigned or routed to a staff member. Staff reply from the CRM, add notes and a follow-up task, and book a consultation.
5. New messages, delivery states, assignment changes, and appointment events appear in the lead timeline.

### J3 — Missed follow-up

At the start of a shift, staff see due and overdue tasks sorted by due time. Completing a task requires an outcome; snoozing requires a new due time. Admin sees overdue counts by owner.

### J4 — Opt-out or booking change

An unsubscribe action immediately suppresses future promotional emails. A cancellation or reschedule updates appointment status and pending reminder jobs; the activity timeline records the change.

### J5 — Existing WhatsApp number connection

Admin opens WhatsApp settings, begins Meta's supported onboarding flow, authorizes the clinic's business assets, and selects the existing WhatsApp Business mobile-app number if eligible. The setup screen checks webhook subscription, inbound receipt, outbound reply, template availability, and whether the mobile app and CRM show the expected new messages. If coexistence is unavailable or history behavior differs, show a clear blocker and require the clinic to choose a supported alternative before cutover. Do not disconnect or migrate the existing number automatically.

## 4. Functional requirements and acceptance criteria

Priority: **P0** = MVP launch blocker; **P1** = next release. IDs are stable references for Claude's tickets and tests.

### 4.1 Identity, contacts, and intake

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| ID-01 | P0 | Staff login, password reset, session expiry, MFA for admin | Unauthenticated requests are rejected; admin can enable MFA; expired sessions cannot access data |
| ID-02 | P0 | Create/edit a person with name, normalized phone, email, preferred contact method, branch, communication preferences | At least one phone or email is required; changes appear in history |
| ID-03 | P0 | Capture manual and walk-in inquiries | Source defaults to Walk-in only when selected; staff can save with service interest and notes |
| ID-04 | P0 | Import CSV with preview and field mapping | Invalid rows are reported; reimporting same import does not duplicate source submissions |
| ID-05 | P0 | Website lead endpoint or embeddable form | Protected by abuse controls; records consent text/version and attribution fields; returns clear success/failure |
| ID-06 | P0 | Match on normalized phone/email and present possible duplicates | Exact matches link to a person; conflicting matches go to review; merge is reversible within retention window or admin-audited |
| ID-07 | P0 | Preserve every incoming submission separately from person and opportunity | Duplicate webhook delivery is idempotent; separate genuine submissions remain visible |
| ID-08 | P0 | General Notes on each person record | Authorized staff can add, view, edit, pin and archive time-stamped notes with author and audit history; notes remain visible across multiple leads for that person and are never exported to ad platforms or inserted into automated messages |

### 4.2 Pipeline and staff work

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| LEAD-01 | P0 | Lead list and Kanban view with search/filter/sort | Filters include stage, owner, source, date, branch and service; counts agree with list |
| LEAD-02 | P0 | Configurable stages, stage history and required reasons for exits | Stage changes write actor/time; Lost and Unqualified require reason; closed leads do not receive active nurture by default |
| LEAD-03 | P0 | Assignment rules and unassigned queue | Rule priority is deterministic; no match goes to queue; admin can reassign |
| LEAD-04 | P0 | Lead detail with activity timeline | Shows source submission, notes, calls/email outcomes, tasks, appointments, automation events and changes in timestamp order |
| LEAD-05 | P0 | Tasks with due date, owner, priority and outcome | Due/overdue views work in clinic timezone; completion records outcome; closed-lead tasks are handled visibly |
| LEAD-06 | P0 | Inquiry-specific notes and contact attempts | Staff can log attempted, connected, no answer, and invalid contact; inquiry notes are separate from person-level General Notes; edit/archive is audited |
| LEAD-07 | P1 | Saved views and bulk assignment | Bulk actions show affected count and require confirmation in UI |

**Default stages:** New, Attempting contact, Connected, Qualified, Consultation booked, Consultation attended, Converted, Nurture, Lost, Unqualified, Duplicate. Admin may rename/reorder active stages, while system outcome categories remain stable for reporting.

### 4.3 Calendar and appointments

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| CAL-01 | P0 | Day/week calendar by staff and branch | Staff see only permitted calendars; time displays in clinic timezone and handles daylight saving |
| CAL-02 | P0 | Consultation types with default duration and buffer | Admin can configure type, duration, staff eligibility and working hours |
| CAL-03 | P0 | Book, reschedule and cancel appointments | Booking rejects overlap for the assigned staff; updates are atomic; reason and actor are logged |
| CAL-04 | P0 | Appointment statuses | Scheduled, confirmed, attended, no-show, canceled and rescheduled are available; status is separate from lead stage |
| CAL-05 | P0 | Confirmation and reminder email jobs | Reschedule/cancel invalidates old jobs; sending respects contact preference and provider availability |
| CAL-06 | P1 | Client booking link and self-service change link | Token is time-limited; availability is checked at final commit; abuse limits apply |
| CAL-07 | P1 | External calendar sync | Provider-specific adapter; conflict behavior and source of truth are configurable |

### 4.4 Email and automation

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| MSG-01 | P0 | Connect an approved email provider and verified clinic sender domain | Admin can test connection; send failures display reason; secrets are encrypted and never shown after save |
| MSG-02 | P0 | Editable templates with approved variables and preview | Missing variables fail validation; rendered messages are stored with template version |
| MSG-03 | P0 | Trigger/action rules for acknowledgment, follow-up, appointment confirmation and reminder | Admin can enable/disable, test with sample lead, set delays and quiet hours, and inspect enrollment |
| MSG-04 | P0 | Consent and suppression controls | Each contact has channel/purpose status, source, timestamp and notice version; email and WhatsApp opt-outs are tracked independently and prevent future promotional sends immediately |
| MSG-05 | P0 | Send safety | Per-contact frequency cap, idempotent send key, retry with limit, and pause on provider error; no duplicate email on event replay |
| MSG-06 | P0 | Reply/booking/close stop conditions | A rule can stop on reply, booking, conversion, opt-out, or closure; scheduled jobs recheck conditions before send |
| MSG-07 | P0 | Message delivery log | Shows scheduled, sent, delivered if available, bounced, failed, canceled and suppressed, with reason |
| MSG-08 | P1 | Staff approval of personalized draft | Drafts can be previewed and approved before send where clinic policy requires it |

**Initial rule templates:** (a) new inquiry acknowledgment, (b) first staff follow-up task if no contact within clinic-defined SLA, (c) consultation confirmation, (d) 24-hour appointment reminder, (e) post no-show staff task. Each rule selects email or WhatsApp independently. Keep promotional nurture disabled until the clinic approves the audience, copy, and legal basis. Email subjects and default calendar titles should be generic (for example, “Your appointment with [Clinic]”).

**US/Florida messaging guardrail:** Classify each template as operational or promotional. Do not assume a marketing email becomes operational because it mentions an appointment. For promotional email, include sender identity, physical postal address, and unsubscribe mechanism, and process opt-outs immediately. The clinic's privacy lead should approve the exact classification and content before production. See [FTC guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) and [HHS marketing guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/marketing/index.html).

### 4.4a WhatsApp shared inbox and messaging

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| WA-01 | P0 | Connect clinic-owned WhatsApp Business account and existing number through a supported Meta path | Admin sees WABA and number IDs, connection state and test results; no raw token is displayed; app remains usable until clinic-approved cutover |
| WA-02 | P0 | Receive inbound messages and status webhooks | Verify webhook, persist event, dedupe by provider message/event ID, attach to conversation, and show sent/delivered/read/failed states when reported |
| WA-03 | P0 | Shared conversation inbox | Unassigned/Mine/All views, unread count, search, assignment, tags, internal notes, and clear last-response time; multiple staff cannot unknowingly reply to the same conversation |
| WA-04 | P0 | Link conversation to person and lead | Match by WhatsApp ID/normalized phone; staff can review ambiguous matches; opening an organic chat or ad chat never erases an earlier lead/source |
| WA-05 | P0 | Reply from CRM | Staff can send allowed text replies and approved templates; message appears once with provider status; attachment types supported only after explicit privacy review |
| WA-06 | P0 | Enforce platform messaging rules | UI shows when a free-form reply is permitted; outside the service window, only approved templates can be selected; paused/rejected templates cannot be sent |
| WA-07 | P0 | Capture click-to-WhatsApp ad context | When reliable ad referral metadata exists, save available ad/campaign identifiers and referral details, and label source `WhatsApp ad`; otherwise show `WhatsApp organic` or Unknown |
| WA-08 | P0 | WhatsApp automation safety | Rule checks channel opt-in, approved template, service window, opt-out, lead/appointment state, frequency cap, and idempotency immediately before send |
| WA-09 | P0 | Connection and continuity checks | Admin sees last inbound/outbound event, webhook failures, number status, and a pilot checklist for mobile-app coexistence and message history |
| WA-10 | P1 | Media and historical chat handling | Add only after confirming provider capability, retention, malware scanning, access control, and clinic approval; never imply old mobile-app chats automatically backfill |

The CRM should not use WhatsApp Web scraping, unofficial browser automation, or a personal WhatsApp account as its integration. Meta's Business Platform supports API messaging and webhook events; the clinic's existing mobile-app number requires eligibility checks for the supported coexistence or migration flow. Do not promise that historic chats will appear in the CRM. Meta's policy says businesses may initiate conversations using approved templates and may send free-form replies within 24 hours of the user's last message. It also requires opt-in for subsequent contact, honoring opt-outs, restricts health-related information where heightened regulatory requirements are not met, and places restrictions on medical and healthcare product messaging. The clinic must review its ad copy, service offers, WhatsApp messages, and privacy obligations before live use. Exact pricing and account eligibility must be checked during setup. [Meta Platform overview](https://www.postman.com/meta/whatsapp-business-platform/overview) · [Meta Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) · [Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/collection/du6gzjv/embedded-signup) · [WhatsApp policy](https://business.whatsapp.com/policy).

### 4.5 Source integrations

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| INT-01 | P0 | Integration settings with connection status, last event, last success, failure count and test action | Admin can distinguish disconnected, healthy and degraded states |
| INT-02 | P0 | Meta Lead Ads adapter | Authorized Page/form selection; leadgen notification triggers lead retrieval; external lead ID provides idempotency; failed fetch can retry/replay |
| INT-03 | P0 | Google Ads lead-form webhook adapter | Verify configured `google_key`; use `lead_id` for idempotency; map `user_column_data` by `column_id`; mark `is_test` separately |
| INT-04 | P0 | Field mapping per form | Admin can map name, email, phone, service interest, preferred time and consent fields; unknown fields are retained in restricted raw event storage |
| INT-05 | P0 | Attribution | Persist platform, account/Page, campaign, ad set/group, ad, form, click ID and UTM fields when provided; missing fields remain null |
| INT-06 | P0 | Replay and reconcile | Admin can replay failed events; daily reconciliation flags gaps where provider access permits; no duplicate opportunities from replay |
| INT-07 | P1 | Historical backfill | Admin selects date range; imported records are tagged as backfill and retain original submission time |
| INT-08 | P0 | WhatsApp webhook adapter and account health | WABA subscription and number mapping work; inbound messages and statuses are durable, idempotent, and replayable; disconnected state alerts admin |
| INT-09 | P0 | Outbound conversion-feedback configuration | Admin sees Meta and Google as separate destinations, mapped milestones, source filters, eligibility status, test result, last accepted event, error count and kill switch |

**Meta implementation note:** Use Meta's official lead retrieval and webhook flow. The app must be approved for the permissions needed by its exact use case, and the clinic must grant Page/lead access. Validate webhook signature/challenge, exchange and store tokens securely, refresh or reconnect as required, and fetch full lead data using the lead ID. Do not promise automatic access before app review and clinic authorization. [Meta retrieval documentation](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/) · [Meta webhook documentation](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration).

**Google implementation note:** Google Ads lead forms can POST to an advertiser webhook configured on the form. Validate the configured `google_key`, handle duplicate deliveries using `lead_id`, ignore unknown payload fields safely, and verify a sample event with Google's test tool. The webhook alone should not be represented as a full Google Ads account connection; account-level setup or reporting requires separate OAuth/API scope and later discovery. [Overview](https://developers.google.com/google-ads/webhook/docs/overview) · [Implementation](https://developers.google.com/google-ads/webhook/docs/implementation) · [Testing](https://developers.google.com/google-ads/webhook/docs/testing).

### 4.5a CRM-to-ad-platform conversion feedback

**Purpose:** When staff mark a lead Qualified, Consultation booked, Consultation attended, or Converted, the CRM can create an outbound milestone. If the milestone is approved for that platform, the adapter reports it back to the originating ad account so campaign reporting and permitted bidding optimization can use a deeper outcome than raw lead count. Lead ingestion and conversion feedback are separate connections and permission sets.

**Qualification rule to confirm with clinic:** A Qualified lead is a genuine, reachable inquiry in the clinic's service area, expresses interest in an offered consultation, and is not a duplicate, test, spam or wrong number. Staff must explicitly confirm the criteria and record the qualification time. A booked appointment is a separate, stronger milestone. Service/condition, diagnosis and treatment details stay inside the CRM.

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FB-01 | P0 | Configurable stage-to-event map per destination | Admin maps Qualified, booked, attended, and converted independently; unmapped stages never send; mapping version is audited |
| FB-02 | P0 | Capture attribution/match keys at intake | Store Meta lead ID for Instant Forms, eligible WhatsApp ad referral ID when provided, Google click ID when provided, and other approved identifiers separately; never fabricate missing keys |
| FB-03 | P0 | Platform eligibility gate and field allowlist | Lead-stage feedback is required; production outbound starts Off until destination account/policy checks pass; allow only the eligible event and matching fields, denying service/condition details and arbitrary CRM fields |
| FB-04 | P0 | Preview and test mode | Admin sees exact event category, timestamp, destination and identifiers to be sent, with personal values masked; test mode sends only permitted test data and cannot silently enable production |
| FB-05 | P0 | Durable, idempotent outbox | One milestone transition creates one candidate per destination; retries preserve event ID; replay does not create duplicate reported conversions |
| FB-06 | P0 | Delivery diagnostics | Show queued, blocked, sent, accepted, rejected, unmatched/unknown if reported, with provider error and retry count; CRM funnel remains independent of platform attribution |
| FB-07 | P0 | Pause/revoke | Admin can stop all sends immediately, disable one milestone, disconnect an account and revoke stored credentials; queued unsent events are canceled when disabled |
| FB-08 | P0 | Google adapter | Use the current supported Google Ads Data Manager path for eligible offline events, conversion action mapping and diagnostics; do not assume enhanced conversions are permitted for this clinic |
| FB-09 | P0 | Meta adapter | Use the current supported Conversions API for CRM/Conversion Leads path for eligible Meta lead-form outcomes; verify event matching and dataset/account permissions; WhatsApp ad outcomes are a distinct mapping that must be validated with Meta |
| FB-10 | P0 | Bidding activation checklist | Sending events does not itself switch campaigns to optimize for them; admin sees the chosen conversion goal, event volume and platform diagnostics before marketer changes bidding settings |

**Google path:** A Google ad click or lead form creates an inquiry with a Google identifier when available. Later, an eligible CRM milestone is mapped to a Google Ads offline conversion action such as Qualified lead, with its actual event time. Google can match a click ID to the original ad interaction, report the conversion, and use the selected conversion action in Smart Bidding after the advertiser configures it. Google's current guidance moves new offline-conversion integrations to the [Data Manager API](https://developers.google.com/data-manager/api/devguides/events/send-events). Google's [customer-data policy](https://support.google.com/adspolicy/answer/7475709?hl=en) explicitly says health or medical conversions, including purchases of medical services, cannot be measured with enhanced conversions. Therefore **do not upload hashed email/phone or enable enhanced conversions for this clinic by default**. Lead-only CRM design does not by itself establish eligibility: a click-ID-only Qualified or booked event can still disclose a clinic relationship. Check the specific clinic service, event, Google account classification and applicable policy before activation; if ineligible, retain the milestone in CRM reporting only.

**Meta path:** A Meta Instant Form lead has a Meta lead ID. When that lead reaches a permitted milestone, the CRM can send a matched outcome through Meta's Conversions API for CRM, after which an advertiser may select an eligible Conversion Leads performance goal. [Meta's lead-generation guide](https://about.fb.com/ltam/wp-content/uploads/sites/14/2023/11/LeadGenerationGuide.pdf) describes this feedback loop. Click-to-WhatsApp ad conversations have a different source and may expose referral identifiers; do not assume an Instant Form lead ID or the same optimization path. Validate supported matching and event destination for WhatsApp ads with Meta before enabling. For all Meta events, screen event names, match keys, URLs, custom data and destination classification for sensitive health information; block anything not approved. The fact that an API accepts an event is not proof that the disclosure is permitted.

**Optimization versus targeting:** A matched Qualified event gives the platform a labeled outcome from a previous ad interaction. The platform may use aggregated examples to predict which future eligible impressions are more likely to produce that outcome **if** the campaign is configured to optimize for it. This does not reveal to clinic staff a list of people Meta or Google will target, and it does not automatically create a retargeting audience. Do not export patient/qualified-lead lists as custom audiences. Google restricts advertiser-curated audiences for sensitive-interest categories. [Google restricted targeting policy](https://support.google.com/adspolicy/answer/143465?hl=en).

### 4.6 Reporting, settings, and audit

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| REP-01 | P0 | Funnel dashboard | Lead, contacted, qualified, booked, attended and converted counts with explicit denominators and date definitions |
| REP-02 | P0 | Source/campaign report | Counts and rates by source and available campaign/form; missing attribution shown as Unknown |
| REP-03 | P0 | Operations dashboard | New/unassigned/overdue leads, tasks, upcoming appointments, no-shows, failed sends and integration alerts |
| REP-04 | P0 | CSV export with role restriction | Export respects current filters and masks fields not available to role; audit includes actor and filters |
| SET-01 | P0 | Clinic settings | Timezone, branch, consultation types, working hours, pipeline, routing, SLA and message rules are admin editable |
| AUD-01 | P0 | Audit log | Records login/admin actions, sensitive record access, exports, merges, deletes, consent changes, rule edits and integrations |

**Metric definitions:** `lead` = one inquiry/opportunity; `person` = unique contact; `booking` = appointment created; `attended` = appointment marked attended; `conversion` = lead marked Converted by staff. Reporting uses clinic-local date for filters and the source attached to that inquiry. Do not calculate ad ROI until ad spend and revenue data are available.

## 5. Data model (logical)

| Entity | Key fields / relationships |
|---|---|
| Clinic, Branch | Clinic settings, timezone; Branch belongs to Clinic |
| User, Role | Clinic/branch membership, status, permissions |
| Person | Name, normalized phone/email, preferred contact, restricted demographic fields if needed; has many General Notes |
| GeneralNote | Person, body, author, created/updated timestamps, pinned/archived state, audit reference; internal only |
| ConsentRecord | Person, channel (email/WhatsApp), purpose, status, timestamp, source, notice version, evidence reference |
| SourceSubmission | Platform, external ID, form/campaign IDs, submitted timestamp, raw payload reference/hash, ingest status; unique `(platform, external_id)` |
| Lead | Person, source submission, service interest, stage, owner, branch, created/closed time, outcome/loss reason |
| LeadStageEvent | Lead, old/new stage, actor, timestamp, reason |
| Activity | Person/lead, type, outcome, actor, timestamp, note reference |
| Task | Lead, owner, due time, status, outcome, priority |
| Appointment | Person, lead, staff, type, branch, UTC start/end, status, change reason |
| WhatsAppAccount, WhatsAppConversation | Clinic-owned WABA/number reference, encrypted credential reference, health; conversation, person, lead, assignee, source, referral context, last inbound timestamp |
| WhatsAppMessage | Provider message ID, conversation, direction, type, restricted body reference, delivery state, timestamp, actor; unique provider message ID |
| AutomationRule, Enrollment, Job | Trigger, conditions, template, schedule, run state, idempotency key |
| Message, Template | Channel, purpose, rendered content/version, recipient, provider ID, delivery state |
| IntegrationConnection, IntegrationEvent | Provider, encrypted credential reference, mapping, health, event/retry metadata |
| ConversionFeedbackRule, ConversionFeedbackEvent | Platform, source filter, mapped milestone, approved field set/version, approval status, CRM transition ID, destination, event ID, event time, send/accept/reject state |
| AuditEvent | Actor, action, entity, timestamp, before/after summary or redacted reference |

Prefer stable UUIDs for internal IDs. Normalize phones to E.164 where possible. Keep original values for audit. Separate raw third-party payloads from ordinary CRM queries, encrypt them, restrict access, and set a retention period. Never put email tokens or full personal data in application logs.

## 6. Screens and navigation

1. **Home:** work queue, overdue tasks, appointments today, ingestion and email alerts.
2. **Inbox:** shared WhatsApp conversations, assignment, unread/response state, linked lead, reply composer and internal notes.
3. **Leads:** list/Kanban, filters, bulk selection, quick-add.
4. **Lead detail:** person summary and General Notes panel, stage, owner, source, timeline, inquiry notes, tasks, appointments, message history, consent.
5. **People:** search, profile with dedicated General Notes section, inquiries, duplicate review and merge.
6. **Calendar:** day/week, staff filter, appointment form and change history.
7. **Automations:** rules, template editor, test preview, enrollment and send log.
8. **Reports:** funnel, source/campaign, staff response, appointment outcomes, export.
9. **Settings:** staff/roles, clinic hours, service types, pipeline, integrations (including WhatsApp account/number), privacy/retention, audit.

Design for quick front-desk use: minimal required fields, clear next action, visible owner, keyboard-friendly forms, and accessible status labels beyond color alone. General Notes should be easy to find from both the person profile and lead detail, with most recent and pinned notes first. Display “test lead” and “failed integration” prominently.

## 7. API and event contracts

Claude should define typed request/response contracts for people, leads, WhatsApp conversations/messages, tasks, appointments, automations, conversion-feedback candidates/status, reports, and admin settings. Suggested endpoint groups: `/auth`, `/people`, `/leads`, `/conversations`, `/tasks`, `/appointments`, `/automations`, `/conversion-feedback`, `/reports`, `/integrations`, `/webhooks/meta`, `/webhooks/whatsapp`, `/webhooks/google`, `/audit`.

Integration processing pipeline: **receive → authenticate/verify → persist event → acknowledge promptly → queue → normalize → deduplicate source event → match person → create/update lead → assign → emit domain event → evaluate automations**. A webhook response must not wait on email sending. Failed jobs use bounded retry and a dead-letter view. Every event has correlation ID, provider event ID, status, attempts, and safe error summary. Admin replay reruns processing idempotently.

Use transactions for booking conflict checks and state changes. Background jobs must re-read current consent, lead stage, appointment state, and rule status immediately before sending. A message idempotency key should include person, rule, trigger event, and schedule instance.

## 8. Security, privacy, and compliance requirements

The clinic must determine with its privacy/legal lead whether it is a HIPAA covered entity and whether CRM data are PHI in its actual workflows. Even without clinical charting, an inquiry linked to a clinic/service may be sensitive. If HIPAA applies, select hosting, email, analytics, monitoring, and other vendors that can meet the clinic's requirements, execute required BAAs before PHI flows, and perform a risk assessment. HHS explains that cloud services storing ePHI for a covered entity can be business associates even when data are encrypted. [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html).

Build controls now: least privilege; MFA for admins; encryption in transit/at rest; secret management; audit trails; encrypted backups and restore test; rate limits; CSRF protection where applicable; input validation; secure file handling; session revocation; dependency updates; production alerting; data export/deletion workflow; retention settings. General Notes and WhatsApp conversations can contain sensitive information even if the product has no clinical charting, so restrict access and keep them out of provider payloads, logs and automated messages. Default to minimal scheduling information and discourage users from sending clinical details. Lead-stage feedback is required; **send only the events and identifiers the destination permits for this clinic after platform/account checks**. Exclude service, condition, diagnosis and treatment details from payloads. Hashing contact information does not remove a health-data restriction. Keep PHI out of generic analytics and email subject lines. Configure vendor telemetry to avoid recording forms and message bodies.

Florida's data-breach statute may affect incident response. The clinic's counsel should set incident procedures and deadlines rather than embedding an assumed legal interpretation into product logic. [Florida Statutes §501.171](https://www.flsenate.gov/Laws/Statutes/2026/501.171).

## 9. Quality targets and release gates

| Area | MVP target / gate |
|---|---|
| Reliability | No acknowledged source event is lost; durable event store and retry path |
| Freshness | Healthy integration processes a new lead within 5 minutes at p95, excluding provider outages |
| UI response | Common list/detail actions within 2 seconds at p95 under agreed pilot load |
| Availability | Target 99.5% monthly app availability after launch; agree support window |
| Backup | Daily encrypted backup; documented restore test before launch; RPO/RTO agreed with clinic |
| Accessibility | Keyboard usable core workflows, labeled controls, readable contrast; aim for WCAG 2.2 AA |
| Privacy | No real client data in development/test environments; vendor and BAA review completed where required |
| Observability | Alert on webhook errors, no events from an active source, queue backlog, email failures and backup failures |

**Pilot UAT scenarios:**

1. Submit one test lead each from Meta lead forms, click-to-WhatsApp ads, Google and website; create one walk-in; verify source and timestamps.
2. Deliver the same provider webhook twice; confirm one source submission and no duplicate email.
3. Match a second inquiry to the same phone; confirm separate lead and shared person.
4. Route and reassign a lead; confirm queue, timeline and audit history.
5. Book an overlapping appointment; confirm conflict error; reschedule and verify old reminder canceled.
6. Unsubscribe before a queued promotional email; verify suppression and recorded reason.
7. Book/convert a lead enrolled in follow-up; confirm irrelevant follow-up stops.
8. Simulate provider outage, recover, replay events, and confirm no lead loss.
9. Verify a practitioner and marketing analyst cannot access forbidden personal fields or exports.
10. Reconcile dashboard counts with filtered lead/appointment lists and CSV export.
11. Connect the clinic's existing WhatsApp Business mobile-app number using the supported onboarding path; verify inbound/outbound messages, mobile-app continuity, visible history boundaries, and disconnect behavior in a pilot.
12. Send duplicate WhatsApp webhook events; confirm one message, one lead event, and no duplicate automation. Test a free-form reply inside and outside the service window and an approved template send.
13. Mark a lead Qualified twice and replay the job; confirm only one feedback event candidate per destination, with stable ID and visible provider status.
14. Attempt to enable an unapproved health-related feedback mapping or forbidden field; confirm send is blocked. Test an eligible mapping with platform test tools and verify that campaign bidding remains unchanged until explicitly configured in the ad account.
15. Add and pin a General Note on a person, open another lead for the same person, and confirm the note is visible there; edit/archive the note and verify audit history and that no note text appears in an automated message or ad-platform payload.

## 10. Delivery plan for Claude

1. Read this PRD and the BRD. Create a brief assumptions/decision log; implement the known scope without waiting on unresolved business choices where safe defaults exist.
2. Inspect the repository and propose a modular architecture suited to its existing stack. If the repository is empty, choose a maintainable web stack with a relational database, background jobs, and typed APIs; document the choice.
3. Build core identity/roles, data model, manual intake, pipeline, tasks and calendar with seed data.
4. Add email and WhatsApp provider abstractions, shared inbox, templates, consent ledger, automation engine and delivery log; keep real sending off in development.
5. Add provider adapters and webhook/event processing with test fixtures, replay and health screens. Support mock connectors so the app is reviewable without credentials. Validate the existing WhatsApp Business mobile-app number's eligibility before a production cutover.
6. Add conversion-feedback outbox, Meta and Google adapters, mapping UI, preview, platform eligibility gate, diagnostics and kill switch. The requester has authorized the feature; enable production sending for an event once its destination account and current policy permit the exact payload.
7. Add dashboards and exports, privacy controls, audit, monitoring and backup/restore documentation.
8. Run meaningful tests for webhook idempotency, permissions, booking conflicts, consent suppression, automation stop conditions, feedback suppression, and funnel calculations. Complete pilot UAT with clinic accounts before production.
9. Produce a deployment guide listing required credentials, provider app review steps, email domain setup, environment variables, migration/backup commands, and launch checklist.

**Definition of done:** The fifteen pilot scenarios pass; production secrets are provisioned securely; real integrations are tested with the clinic's accounts; the clinic approves message copy and privacy settings; staff can complete the full inquiry-to-appointment workflow from the shared inbox; owner signs off on reports and training. Conversion-feedback infrastructure is complete and tested; production sending is enabled for platform-eligible lead-stage signals.

## 11. Decisions still needed

| Decision | Default until answered |
|---|---|
| Clinic specialty and services | Generic consultation types and free-text service interest |
| Number of branches and staff | One branch, configurable users |
| Email and calendar provider | Provider interfaces plus mock; choose before production |
| Existing WhatsApp number eligibility and history behavior | Preserve the mobile app; use a mock in development and validate Meta-supported coexistence/onboarding in pilot before cutover |
| Qualified-lead definition and conversion goal | Staff-confirmed criteria above; choose one primary optimization milestone after observing quality and volume |
| Ad-platform feedback eligibility for clinic data | Lead-stage feedback is required; verify each destination's current health-data rules and account restrictions for the clinic's exact service and payload |
| Clinic business hours and appointment durations | Admin-configurable sample values, never treated as actual hours |
| Exact lead stages and SLAs | Defaults in this PRD, editable by admin |
| Consent copy, privacy notice, retention and HIPAA/BAA status | No live promotional sends; no real data until approved |
| Existing data migration | CSV import with preview; mapping confirmed during pilot |
| Hosting and data region | Select after clinic security review |

## 12. Out of scope for MVP

Clinical records, diagnosis, treatment notes/photos, prescriptions, insurance, payments, invoices, inventory, SMS, call recording, automated campaign/budget changes, AI-generated medical advice, and patient-list audience creation. These need separate requirements and privacy review.
