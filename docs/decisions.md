# Decision log

Why each choice was made, so a later session does not undo a deliberate
decision. Newest at the bottom of each section.

Format: **decision** — rationale — what would change it.

---

## Product scope

**D-01. Build as multi-tenant SaaS from day one, not single-clinic.**
The product will be sold to the first client and other clinics. Retrofitting
tenancy is a rewrite of every query and every index. Chosen over single-tenant
deployments because per-clinic ops cost compounds with each customer.
*Would change if:* a customer demands physically separate infrastructure for a
compliance reason — in which case the same code deploys single-tenant, since
`clinic_id` is still present.

**D-02. Row-level security in Postgres, not application-level filtering alone.**
Application filtering fails open: forget one `where clinicId = ...` and you leak.
RLS fails closed: the same mistake returns an empty list. The app connects as a
non-owner role with `FORCE ROW LEVEL SECURITY` so even the owner path cannot
bypass policies. Both layers are kept — RLS is the backstop, not an excuse to
skip explicit filters.
*Would change if:* never, within this architecture.

**D-03. Requirement IDs from the PRD are used as the ticket and test vocabulary.**
`ID-01`, `LEAD-02`, `WA-06`, `FB-03` appear in code comments, status tables and
test names, so a reviewer can trace any line back to a requirement and the client
can check coverage.

---

## Stack

**D-04. TypeScript monorepo with pnpm + Turborepo.**
One language across web, API and worker means the Zod contract that validates a
request also types the form that produced it. Chosen over Python/FastAPI because
the shared-contract benefit outweighs Python's edge in reporting work, and the
reporting here is SQL aggregation rather than data science.

**D-05. ~~NestJS for the API.~~ Superseded by D-24.**

**D-06. Drizzle rather than Prisma.**
Raw SQL is needed for exclusion constraints, `set_config`, RLS policies and
window-function reporting. Drizzle stays close to SQL and lets the schema live in
TypeScript without an extra DSL and generated client.

**D-07. BullMQ on Redis for jobs.**
Durable retry, delayed jobs and dead-lettering are hard requirements (PRD 7), and
appointment reminders need reliable scheduling weeks out. Redis is already a
sensible dependency; a Postgres-only queue would need the same features rebuilt.

**D-08. Packages export TypeScript source, with extensionless relative imports
and `moduleResolution: "Bundler"`.**
NodeNext requires `.js` specifiers that only resolve after a compile step. That
broke `drizzle-kit`'s CJS config loader and the `tsx` migration scripts during
setup. Every tool in this stack (tsx, Vitest, Next's `transpilePackages`, tsup)
understands extensionless imports.
*Consequence:* do not add `.js` to relative imports. Documented in
ARCHITECTURE.md section 2.

**D-09. Postgres on port 5433 and Redis on 6380.**
Off the defaults so a developer's existing local Postgres or Redis cannot be hit
by accident — a `pnpm db:reset` aimed at the wrong database would be
unrecoverable.

---

## Security and privacy

**D-10. Argon2id for passwords; SHA-256 for opaque tokens.**
Different problems. Passwords are low-entropy and user-chosen, so they need a
slow memory-hard hash. Session and invite tokens are 256 bits from a CSPRNG, so
there is nothing to brute-force and lookup must be fast enough for every request.
Using Argon2 for session tokens would add latency for no security gain.

**D-11. Sessions stored as hashes, with a `session_epoch` for mass revocation.**
Reading the database must not yield a usable credential. A single integer bump
revokes every session for a user on password change, role change or suspension,
without scanning and deleting rows.

**D-12. Envelope encryption binds the clinic id as additional authenticated data.**
A per-clinic HKDF-derived key limits blast radius, and the AAD binding means a
ciphertext moved from clinic A's row to clinic B's row fails to decrypt instead of
silently yielding A's secret. This turns a plausible logic bug into a loud error.

**D-13. `CRYPTO_PROVIDER=local` is refused when `NODE_ENV=production`.**
A dev master key that leaks would decrypt every clinic's provider credentials.
Production must use a KMS.

**D-14. The audit trail is append-only at the privilege level.**
`UPDATE` and `DELETE` on `audit_events` are revoked from the application role, so
a fully compromised app process cannot rewrite history. Same reasoning for
revoking `INSERT`/`DELETE` on `clinics`: provisioning a tenant is an operator
action, not something an API bug can do.

**D-15. Marketing analysts get no `people:read` and no `leads:read` capability
at all.**
Rather than granting read and masking fields afterwards, the capability is simply
absent, so no route can return a personal record to that role even by mistake.
Field masking still exists as defence in depth.

---

## Compliance posture

**D-16. All outbound sending is off by default, behind two switches.**
`OUTBOUND_SENDING_ENABLED` is the global kill switch; `CONVERSION_FEEDBACK_ENABLED`
is a stricter one for ad-platform events. The PRD requires that the app be
reviewable with no credentials and that nothing reach a real client before the
clinic approves copy and privacy settings.

**D-17. No hashed email or phone is in the conversion-feedback allowlist.**
Google's customer-data policy states health or medical conversions, including
purchases of medical services, cannot be measured with enhanced conversions.
Hashing does not remove a health-data restriction. Click-ID-only events are used,
and even those need per-destination eligibility review before production.
*Would change if:* the clinic's counsel and the platform both confirm eligibility
for the clinic's exact service and payload, recorded against a specific
`feedback_eligibility_state`.

**D-18. Conversion feedback uses an allowlist, not a denylist.**
A denylist means every new CRM field is transmitted until someone remembers to
block it. The allowlist means a new field is invisible to the adapter until
explicitly approved, with a versioned approved field set.

**D-19. Promotional sending is gated on a per-clinic approval flag.**
`clinics.promotional_sending_approved` defaults to false, including in the seed.
A template classified `promotional` cannot send without it, plus sender identity,
postal address and an unsubscribe mechanism (FTC CAN-SPAM guidance).

**D-20. Seeding refuses to run when `NODE_ENV=production`, and `db:reset` also
refuses a hosted-looking `DATABASE_URL`.**
PRD 9 requires no real client data in development or test. The inverse matters
just as much: no fake data in an environment holding real records.

**D-21. General Notes belong to the person, and never leave the CRM.**
They are internal staff context that may contain sensitive detail even though the
product has no clinical charting. Excluded from ad-platform payloads, automated
message bodies and logs by construction, not by convention.

---

## Testing

**D-22. The RLS isolation suite is treated as the product's load-bearing test.**
It covers fail-closed reads, cross-tenant read and write attempts, the
transaction-scoped tenant setting, and the privilege restrictions. The seed
creates a second clinic specifically so leakage is visible by hand as well as in
CI.
*Rule:* adding a tenant table means adding it to the `tenant_tables` array in
`packages/db/sql/900_rls.sql` and extending this suite.

**D-23. Database tests run against the real Postgres, not a mock or SQLite.**
RLS, exclusion constraints, `set_config` and partial unique indexes are the
things most worth testing, and none of them exist in a substitute engine.

---

## API framework

**D-24. Fastify for the API, replacing the planned NestJS (supersedes D-05).**
NestJS resolves providers from `emitDecoratorMetadata`, which esbuild does not
emit — and esbuild is what tsx, Vitest and tsup all use here. Keeping NestJS would
have meant either SWC plugins throughout the toolchain or `@Inject()` on every
constructor parameter, and its tsc-based build does not handle workspace packages
that ship TypeScript source (D-08).

The reason NestJS was chosen in the first place — one place to attach the
capability check and the tenant transaction — is met by the `registerRoute` helper
in `apps/api/src/route.ts`. Routes declare `auth` and their schemas and receive a
tenant-scoped transaction; there is no way to register a route that skips either,
because `getTx()` only resolves inside the transaction the helper opens. That is a
stronger guarantee than a guard an author can forget to annotate.
*Would change if:* the API grows to need Nest's module ecosystem more than it
needs a fast, dependency-light toolchain.

**D-25. Credential rate limiting is per IP; per-account protection is the login
lockout.**
The first implementation keyed the rate-limit bucket on IP *and* the submitted
email. It silently did nothing: `@fastify/rate-limit` runs in `onRequest`, before
the body is parsed, so `request.body` is undefined and every login collapsed into
one per-IP bucket — which also made the limit far too tight for a clinic behind a
single NAT. Rather than move rate limiting to `preHandler` purely to read an
email, the two concerns are now separated: a coarse per-IP cap (30 per 5 minutes)
stops one host spraying many addresses, and the per-account lockout (5 failures,
15 minutes) stops a targeted attack from anywhere. Both are tested.

**D-26. A foreign record returns 404, not 403.**
RLS hides the row, so the lookup misses and the natural answer is "not found".
Kept deliberately rather than distinguishing the two: replying 403 would confirm
that a record exists, which is itself a disclosure across a tenant boundary.

**D-27. One database transaction per request.**
Gives atomicity and RLS in the same mechanism. The cost is that a slow handler
holds a pooled connection, so long-running work (CSV import, backfill,
reconciliation) belongs in a worker job that opens its own `withTenant` per unit
of work rather than on the request path.

**D-28. Sessions are resolved unscoped, then everything else is scoped.**
A session cookie cannot be looked up inside a tenant transaction because the
clinic is unknown until the row is read. That lookup, the login email lookup and
single-use token redemption are the only three `withoutTenantScope` callers, and
each passes a written reason so review can grep for them.

**D-29. Email is unique per clinic, not globally.**
The same person may work at two clinics on the platform. Login handles the
ambiguity by verifying the password against every match and, if more than one
matches, returning `clinic_selection_required` with the clinic names — disclosed
only after the password is proven, so it tells an attacker nothing they did not
already have.

---

## Core CRM (phase 2)

**D-30. Matching keys are indexed but not unique.**
A unique index on normalized phone would reject the second inquiry outright.
PRD ID-06 wants the opposite: detect, present the candidates, and let a human
decide. So duplicates are possible by construction and surfaced through a 409
carrying the candidate records, plus a review queue. Creating one anyway needs
an explicit `allowDuplicate`.

**D-31. Milestone timestamps are written once and never moved.**
`qualifiedAt`, `bookedAt`, `attendedAt` and `convertedAt` are stamped the first
time a lead reaches that stage category and are not re-stamped if it bounces
back and forward. Two reasons: the first occurrence is the truthful "when did
this happen", and conversion feedback reports event time — re-stamping would let
one outcome be reported twice with different times, which is exactly what
PRD FB-05 forbids.

**D-32. Reopening a closed lead clears the closure but keeps the milestones.**
`closedAt` and `lossReason` are cleared so it stops counting as closed;
`qualifiedAt` and friends stay, because they record things that genuinely
happened.

**D-33. A lead's `source` is immutable; corrections go in `reporting_source`.**
BRD 7 makes the source and external submission id immutable after ingestion. A
staff correction is additive and audited, so the evidence of what the provider
actually sent is never edited away.

**D-34. Inquiry notes and General Notes are different things and stay separate.**
An inquiry note is a timeline activity on one lead. A General Note belongs to
the person and follows them across every inquiry. PRD LEAD-06 asks for both, and
conflating them would either lose per-inquiry context or spray one inquiry's
detail across unrelated ones. There is a test asserting a lead note does not
appear as a General Note.

**D-35. Lead visibility is narrowed in SQL, not after fetching.**
A practitioner has `leads:read` but not `leads:read_all`, so their list query
gets `owner = me OR owner IS NULL` pushed into the WHERE clause. Filtering after
the fact would make the total count disagree with the rows, which is visible and
confusing; it would also leak counts of records they cannot see.

**D-36. Query-string booleans use a dedicated parser, never `z.coerce.boolean()`.**
`z.coerce.boolean()` applies `Boolean(value)`, and `Boolean("false")` is `true`.
Every `?includeClosed=false` silently meant the opposite. `queryBoolean()` in
`packages/contracts/src/common.ts` parses true/false/1/0/yes/no properly.
*Rule:* never use `z.coerce.boolean()` on a query parameter in this codebase.

**D-37. POST returns 200 by default; only genuine creations declare 201.**
The route helper originally answered 201 for any POST that returned a body, which
is wrong for the many action endpoints here — change a stage, complete a task,
assign a lead. Creations state `status: 201` explicitly.

**D-38. A foreign record answers 404 even for actions, and a foreign *reference*
answers 400.**
Fetching another clinic's lead is a 404 (RLS hides it). Passing another clinic's
stage id or user id into a request body is a 400 with a clear message, because
without the check RLS would make it a silent no-op that looks like success.

**D-39. "Due today" is computed in the clinic's timezone.**
The task views resolve the end of the clinic-local day and convert to a UTC
instant. Using the server's timezone puts the boundary in the wrong place, which
front-desk staff notice every evening.

---

## Calendar (phase 3)

**D-40. Double-booking is prevented by a Postgres exclusion constraint, not an
application check.**
`exclude using gist (staff_user_id with =, tstzrange(starts_at, ends_at) with &&)`
on `appointments`, skipping cancelled and rescheduled rows. A read-then-write
check races: two receptionists booking the same slot in the same moment would
both see it free and both writes would land. The API only translates Postgres
error `23P01` into a 409. A test inserts directly, bypassing the API, to prove
the guarantee does not depend on application code.
*Consequence:* the constraint lives in `packages/db/sql/920_constraints.sql`,
re-applied after every migration, because Drizzle cannot express it.

**D-41. The reserved range includes the consultation type's buffer.**
`ends_at` covers duration plus buffer, and `client_visible_ends_at` covers only
the duration. The buffer has to be inside the range the exclusion constraint
sees, or it protects nothing; the client is still told the shorter time.

**D-42. Rescheduling frees the old row before inserting the replacement, in the
same transaction.**
Otherwise the constraint sees the original booking and refuses any new time that
overlaps it — including nudging an appointment by ten minutes, which is the most
common reschedule there is.

**D-43. Working hours are stored as clinic-local wall-clock time.**
"We open at nine" must stay true across a daylight-saving change. A stored UTC
time would silently shift the clinic's opening hour twice a year. All conversion
goes through the IANA database via `Intl`, with a two-pass offset measurement so
times near a DST boundary land in the right hour. Tested either side of a
transition.

**D-44. Appointment status is independent of lead stage, with one deliberate
exception.**
Booking advances the lead to Consultation booked and marking attended advances
it to Consultation attended, because those are pipeline milestones the clinic
reports on and later feeds back to ad platforms. **Cancelling does not move the
lead at all** (BRD 6: changing an appointment must not silently overwrite the
stage). Both advances are forward-only, so a follow-up appointment cannot drag
an attended or converted lead backwards.

**D-45. Booking outside working hours is allowed, but must be explicit.**
It answers 422 `outside_working_hours` unless `allowOutsideWorkingHours` is set.
Clinics genuinely do run early and late appointments; refusing outright would
push staff to work around the system. A clinic with no hours configured at all
is not blocked.

**D-46. `rescheduled` is not a status a user can set directly.**
It is set by the reschedule flow, which also creates the replacement row.
Allowing it in the status endpoint would leave an appointment marked rescheduled
with nothing to point at.

---

## Messaging (phase 4)

**D-47. One `evaluateSend` gate, called immediately before sending.**
Every condition from MSG-04..06 lives in a single function in
`apps/api/src/messaging/send-gate.ts`, so no send path can skip one. It runs at
send time, never at schedule time: a message queued yesterday must be re-checked
against consent, lead stage, template approval and the service window as they
are *now*, because all four can change in between (PRD 7).

**D-48. A blocked message is recorded, never dropped.**
The gate returns a `SuppressionReason` rather than throwing, and the caller
writes a `suppressed` row to the delivery log with that reason. "Why did my
client not get the reminder" has to be answerable, and an absent row answers
nothing (PRD MSG-07).

**D-49. The message row is written before the provider is called.**
The unique index on `(clinic_id, idempotency_key)` has therefore already claimed
the key by the time anything leaves the process. A crash between write and send
leaves a `sending` row to reconcile, which is recoverable; the reverse order
risks a silent double send, which is not.

**D-50. Operational messages may go out on unrecorded consent; promotional may
not.**
A clinic confirming an appointment the client booked has a plain legitimate
basis. Marketing does not, and needs an explicit `granted` plus a clinic-level
`promotional_sending_approved`. Individual consent alone is deliberately not
enough — PRD 4.4 wants the clinic's privacy lead to sign off on copy and legal
basis before any promotional sending at all.

**D-51. CAN-SPAM requirements are enforced when the template is saved.**
Promotional email must contain `{{link.unsubscribe}}` and `{{clinic.address}}`,
checked at save time so the clinic finds out while editing rather than through a
suppressed send days later.

**D-52. The unsubscribe link is generated by the sender, not the template author.**
A stateless HMAC token (`packages/security/src/unsubscribe.ts`) identifying
clinic, person and channel. Stateless because an unsubscribe link must keep
working months later and every click, which a single-use stored token would not;
signed so it cannot be edited into someone else's opt-out. It grants nothing
except the ability to stop messages.

**D-53. The WhatsApp service window keys on the Meta template name, not on
whether a CRM template row exists.**
A CRM template row with no `whatsapp_template_name` is free-form copy that Meta
never approved, so the 24-hour window governs it. Only a genuine approved Meta
template is exempt. Conflating the two would have let free-form text go out at
any time purely because it was saved as a template, which is exactly the rule
PRD WA-06 exists to prevent.

**D-54. Suppressions are a separate table from the consent ledger.**
Consent is what the person agreed to; a suppression is what happened afterwards
— a hard bounce, a complaint, an unsubscribe click. Both block a send, and
merging them would lose the difference between "never agreed" and "agreed, then
the address bounced".

**D-55. A missing template variable fails the send rather than rendering a gap.**
`renderTemplate` leaves the `{{token}}` in place and reports it, and the send
service refuses. A silently blanked variable reads as finished text and goes out
looking broken to a client.

**D-56. A live connector that does not exist fails loudly.**
`getConnectors()` throws when `CONNECTOR_*=live` and no live adapter is written,
rather than falling back to a mock. Quietly mocking in production would mean a
clinic believing messages were sent when nothing left the building.

**D-57. The pipeline is six stages: New, Contacted, Booked, Visited, Won, Lost.**
The client found eleven stages too many — staff do not distinguish "attempting
contact" from "connected" from "qualified" for every inquiry. The retired
categories (`attempting_contact`, `qualified`, `nurture`, `unqualified`,
`duplicate`) stay in the Postgres enum so history and the conversion-feedback
mapping keep working, but they are no longer seeded and existing clinics have
them deactivated by `packages/db/sql/930_simplify_pipeline.sql`, which moves
leads in them to their successor (`RETIRED_STAGE_CATEGORIES`) and writes that
move to stage history. `changeStage` refuses an inactive stage. The `qualified`
feedback milestone therefore cannot be reached through the UI any more; if
Qualified-based ad optimisation is needed later (PRD 4.5a), reactivate the stage
for that clinic rather than re-adding it for everyone.

**D-58. Automations are linear: one trigger, then an ordered list of steps.**
Drawn top to bottom on a canvas, Zapier-style, with a "+" between steps. No
branching trees: a clinic needs "when X, wait, check, send", and branching is
where builders stop being usable by the front desk. "Only continue if" (a filter
step) covers the real conditional need. Trigger and steps are JSON validated by
the shared Zod schema (`packages/contracts/src/automations.ts`), so the canvas
and the API cannot disagree about what is valid.

**D-59. Postgres is the job queue; the worker is a second entry point of the API.**
Automation runs (`automation_enrollments`) are rows with `next_run_at`. They are
created in the same transaction as the event that caused them, so a trigger is
never lost and never fires for something rolled back — which a separate Redis
queue cannot promise without an outbox. The worker claims due rows with
`UPDATE … FOR UPDATE SKIP LOCKED` (safe with many workers), then runs each inside
its clinic's tenant transaction. It lives at `apps/api/src/worker/` rather than a
separate `apps/worker` package so it shares services without duplication. Redis
and BullMQ are not used; keep Redis in docker-compose only for future rate
limiting. In development the API runs the worker in-process (`WORKER_IN_API`).

**D-60. Each run snapshots the rule's steps; pausing a rule stops everyone in it.**
Editing a rule must not change what an in-flight run does halfway through (a
reminder sequence gaining a marketing step for people already enrolled is a
consent problem). Pausing stops active runs rather than freezing them, because
"paused" that silently resumes weeks later with stale messages is worse than
"stopped" with a recorded reason.

**D-61. Quiet hours are waited out, not recorded as a block.**
An automation step due in quiet hours reschedules itself to the end of the
window (probed a minute at a time with the same `Intl` check the gate uses, so
DST cannot make them disagree). A reminder due at 22:00 should arrive at 08:00,
not never. If a clinic makes every hour quiet, it waits a day rather than
sending anyway.

**D-62. Email "live" mode is SMTP.**
`SmtpEmailConnector` (nodemailer) works with any relay — SES, Postmark,
SendGrid and Mailgun all provide SMTP — so no provider is locked in. In
development `CONNECTOR_EMAIL=live` points at Mailpit (docker compose,
http://localhost:8025). Invite and password-reset emails go through the same
connector but bypass the client send gate: they are account email to staff, and
a reset that waits for the end of quiet hours is a locked-out front desk.

**D-63. "Qualified" means booked.**
At the client's request the pipeline's third stage is named **Qualified**, with
the hint "Booked an appointment" everywhere it appears (`STAGE_HINTS`). Its
category is still `consultation_booked`. Entering it stamps both `bookedAt` and
`qualifiedAt` (once each), so the Qualified conversion signal for Meta/Google
(PRD 4.5a) exists again and needs no separate stage. `930_simplify_pipeline.sql`
backfills `qualified_at` from `booked_at`.

**D-64. The inbox is a view over the delivery log, not a second message store.**
`conversations` holds one thread per person per channel (assignee, status,
unread count, 24-hour window start, preview). Every WhatsApp message — inbound,
staff reply, automation send, even a blocked one — is a row in `messages` with
`conversation_id`. So the send gate, the delivery log, the automation "They
reply" stop condition and the service-window check all read the same rows.
Inbound messages from unknown numbers go through the normal intake pipeline and
become a person and a `whatsapp_organic` lead. Staff replies ignore quiet hours
(a live conversation), but nothing else in the gate.

**D-65. Reply collision is a soft lock, not a hard one.**
Typing in a thread sets `replying_user_id` for 45 seconds; a colleague's reply
during that time gets a 409 naming who is replying. It expires on its own, so an
abandoned tab never blocks anyone for long (PRD WA-03).

**D-66. Unsubscribing withdraws marketing consent only.**
The public `/unsubscribe/[token]` page records a `withdrawn` promotional consent
row for that channel rather than a hard suppression, so the patient still gets
appointment confirmations and reminders — which is what unsubscribing from a
marketing email means. The page names the clinic, never the person.

**D-67. Notes and Activity are clinic-wide feeds, grouped by day.**
Doctors asked to catch up without opening patients one by one. `/notes` lists
every General Note (search covers note text and patient name; filters: pinned,
written by me) with a write-a-note box that asks "who is this about?" first.
`/activity` lists the activity timeline across patients with plain groups
(Calls, Messages, Appointments, Notes, Lead progress, Tasks), "Everyone / Just
me", and a patient picker. Staff without `leads:read_all` see only activity they
did or on leads they own.

**D-68. Phone layout: four tabs plus "More"; tables stack into cards.**
Home, Inbox, Leads and Calendar are the tab bar; everything else is in a "More"
sheet with large rows. Tables use the `.stack-table` class (globals.css) so each
row becomes a labelled card below 640px instead of scrolling sideways. The
calendar shows a day strip and an agenda list on phones and a time grid from
768px up.

**D-69. Leads move forward only.**
`changeStage` refuses an open stage earlier than the furthest open stage the
lead has ever reached (from stage history). Won and Lost are always allowed;
a closed lead can be reopened at or beyond where it had got to. The lead DTO
carries `furthestPosition` so the board and stepper grey out earlier stages.

**D-70. Every WhatsApp inquiry is a lead.**
An inbound message from a known patient with no open lead creates a new
`whatsapp_organic` lead (via intake, `externalId = wa-msg:<provider id>`), so a
conversation never lives only in the inbox.

**D-71. Ad-platform and WhatsApp webhooks queue events; the worker processes them.**
`/webhooks/meta` (Lead Ads), `/webhooks/whatsapp` (messages + delivery statuses)
and `/webhooks/google/lead-form` verify the sender (Meta: X-Hub-Signature-256
over the raw body; Google: the per-clinic key, stored hashed for lookup and
encrypted), resolve the clinic from `integration_connections.external_account_id`,
write an `inbound_events` row (payload encrypted, idempotent on the provider id)
and answer 200. The worker fetches the Meta lead with the page token, maps the
answers and runs the normal intake pipeline; failures retry with exponential
backoff and show on Settings → Lead sources & messaging. Credentials are per
clinic, encrypted with `encryptForClinic`, never returned. Live WhatsApp sends use
the clinic's own number and token (`WhatsAppCloudConnector`).

**D-72. Reporting was parked, then unparked (2026-09-28).**
`/reports/summary`, `/reports/export` (CSV, personal columns only for roles with
`people:read`, formula-injection safe, audited) and the `/reports` page. It was
hidden from the nav at the client's request for a while; it is back in
`NAV_SECTIONS` (`apps/web/src/components/nav.tsx`) behind `reports:read`.

**D-73. Response-time SLA per clinic, measured to the first human response.**
`clinics.first_response_sla_minutes` (0 = off) fixes `leads.sla_due_at` when the
lead is created. `first_response_at` is stamped by the first thing a *person*
does: a logged contact attempt (any outcome), a sent message, or a stage move.
Automated messages don't count. The worker stamps `sla_breached_at` once
(`UPDATE … SKIP LOCKED`) and, if `sla_escalation_enabled`, adds an urgent task
for the owner and emails the owner and admins. Changing the target applies to
new leads only. Wall-clock minutes; business-hours SLAs are a later refinement.

**D-74. Staff lead alerts are an automation step, not a separate feature.**
"Email the team" (`notify_team`) sends internal email to the lead's owner, all
admins, everyone, chosen staff and/or typed addresses, resolved at run time.
It uses the system-email path (no patient consent applies; not quiet-houred)
and carries only name, source, optional phone/email, the first line of the
inquiry and a link. The "Email new leads to the team" recipe sets it up in one click.

**D-75. Production master key: a strong secret from a secret manager, not KMS (yet).**
The production gate used to require `CRYPTO_PROVIDER=aws-kms`, which was never
implemented — production could not have started. It now accepts `local` with a
master key and session secret of at least 32 characters, different from each
other, injected from the host's secret manager, and refuses `aws-kms` with a
clear message until a KMS-wrapped key is built. It also refuses live email
pointed at localhost. Found by booting the production image (phase 9).

**D-76. Phase 9 operations model.**
One VM, docker compose (`deploy/`), Caddy for HTTPS on one domain routing
`/webhooks`, `/public` and `/health` to the API and everything else to the web
app. API and worker share one image. Migrations run as a one-shot service before
either starts. Encrypted daily `pg_dump` via `scripts/backup.sh`, restore test via
`scripts/verify-backup.sh`. The worker writes an `ops_heartbeats` row every tick;
`apps/api/src/ops/monitor.ts` checks the PRD 9 alert conditions every 5 minutes
and emails `OPS_ALERT_EMAIL` (hourly per problem); `/health/alerts` exposes the
same to an uptime monitor behind `MONITOR_TOKEN`. Retention deletes raw provider
payloads after `RAW_PAYLOAD_RETENTION_DAYS` and processed events after 90 days;
personal records are never deleted on a timer.

**D-77. In-app notifications with a bump-not-pile rule.**
`notifications` rows are per user, unique on `(user_id, dedupe_key)`; a repeat of
the same thing (another message in the same chat, the same lead) re-opens and
re-dates the existing row instead of adding one. Sources: new unowned lead
(to everyone with `leads:assign`), lead assigned (new owner), appointment within
60 min (the staff member), task due (owner), missed response time (owner +
admins), WhatsApp message (assignee, or `conversations:assign` if unassigned).
Never to the person who caused it. People mute types in My profile
(`users.muted_notifications`). The bell polls every 30 s; no push or email here —
staff email alerts are the "Email the team" automation step (D-74).

**D-78. Light theme only, at the client's request.** Dark palette and `dark:`
classes removed; `color-scheme: light` so browser controls match.

**D-79. Conversion feedback: reviewed before anything queues; allowlist, not blocklist.**
`feedback_destinations` (one per clinic per platform) starts `unreviewed` and
queues nothing. A three-point checklist moves it to `approved_test_only`;
Go live (`approved_production`) is refused until a test event succeeded.
Candidates are created only while a destination is reviewed and not paused, so
approving later never back-fills old outcomes. The outbox (`feedback_events`) is
unique per clinic × destination × lead × milestone, with a stable `event_id`
(sha256), so repeats and replays can't double-report (UAT 13). The gate runs at
send time: installation switch `CONVERSION_FEEDBACK_ENABLED`, pause, mapping still
on, eligibility, credentials, test code. The payload builder has fields for the
event name, time, id and one platform identifier only (Meta lead id / WhatsApp
referral / gclid) — there is no path to add anything else (FB-03). Event names are
screened for service and health words (UAT 14). Credentials are separate from lead
ingestion and encrypted per clinic. Test events use Meta's test event code or
Google's validate-only.

**D-80. Google feedback uses the Data Manager API, click ID only.** No hashed
email/phone and no enhanced conversions (Google's health policy). The request
shape is marked "verify before go-live" in `google/data-manager.ts`; the test-mode
gate exists so it is proven against the real account before real events flow.

**D-81. Staff removal: Archive (reversible) and Delete (permanent, non-admins only).**
Archive (`DELETE /users/:id`) suspends and hides an account; history stays
attributable. Delete (`DELETE /users/:id/permanent`) removes the row, and is
refused for admins ("change their role first") and for yourself. Anyone with
appointments cannot be deleted (`appointments.staff_user_id` is `ON DELETE
RESTRICT`, surfaced as a 409 telling you to archive instead). Audit rows keep a
denormalized `actorLabel`, so the trail survives a delete. Both archive and
role/status changes share `assertNotLastActiveAdmin`.

**D-82. Session revocation joins the request's transaction.** Changing a role,
status or capabilities revokes the person's sessions by bumping
`users.session_epoch`. It used to do this in a *second* transaction while the
request's transaction still held the row lock from its own update, so the
request waited forever (Postgres cannot see a wait cycle that runs through the
application). `revokeAllSessionsForUser` now uses the request transaction when
there is one. Found by the staff-delete tests; role changes and archive were
hanging in the UI before this.

**D-83. Notes and Activity share one filter panel.** `FeedFilters`
(`apps/web/src/components/feed-filters.tsx`): patient (and search, on Notes), a
row of narrowing selects, a from/to date range in clinic days, and Group by.
Nothing reloads until **Apply filters**, active filters repeat below as removable
chips, the result count is announced (`aria-live`), and on phones the panel
folds away behind a "Filters (n on)" button. Every filter is a URL parameter.
Groups use one heading component (`FeedGroup`) with a count. The API filters
dates as whole days in the clinic's time zone (`from`/`to` on `GET /notes` and
`GET /activities`).

**D-84. New clinics are created with `pnpm db:create-clinic`, which invites the admin.**
`packages/db/src/provision.ts` creates the clinic, default branch, pipeline, the
first admin (status `invited`, no password) and a 7-day invite token, in one
transaction, and prints the accept-invite link once. The operator never chooses
or sees the clinic's password. The demo seed still refuses production.

**D-85. Readiness is 503 when degraded; alert emails retry until delivered.**
`/health/ready` returns 503 if the database is down or the worker has not beaten
for 3 minutes, so probes act on it. `runMonitor` records an alert's hourly quiet
period only after the email is confirmed sent. `deploy/docker-compose.prod.yml`
pins `NODE_ENV=production` on every app service, because `.env.example` says
`development` and the production safety gate only runs in production.

**D-86. Backup scripts read `.env` as data and find Postgres themselves.**
`scripts/lib/pg.sh` never `eval`s or sources `.env` (passwords with `$`, backticks
or `;` stay literal), percent-decodes URL credentials, prefers `POSTGRES_*` when
present (production), and runs the client tools in `PG_CONTAINER`, else the
production compose `postgres` service, else the dev container, else on the host.
