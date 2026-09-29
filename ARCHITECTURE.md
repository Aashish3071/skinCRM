# SkinCRM — Architecture

How the system is put together, and the rules that must not be broken. Read
[README.md](README.md) for how to run it and [docs/HANDOFF.md](docs/HANDOFF.md)
for the current resume point.

---

## 1. Shape of the system

```
                    ┌──────────────┐
  staff browser ───▶│  apps/web    │  Next.js App Router, server components
                    │  (port 3000) │  for reads, server actions → API for writes
                    └──────┬───────┘
                           │ typed fetch, session cookie
                    ┌──────▼───────┐
  ad platforms ────▶│  apps/api    │  Fastify. REST + webhook receivers.
  WhatsApp     ────▶│  (port 4000) │  Verifies, persists, acknowledges, enqueues.
                    └──┬───────────┘
                       │
             ┌─────────▼──┐  ┌─────────────────────┐
             │ PostgreSQL │◀─│ worker               │  automation runs, housekeeping;
             │  (RLS)     │  │ apps/api/src/worker  │  later: ingest, feedback outbox
             └────────────┘  └─────────────────────┘
```

Three processes, one database, and **Postgres is the queue** (D-59). Work is a
row with a due time — an automation run is an `automation_enrollments` row with
`next_run_at` — written in the same transaction as the event that caused it. The
worker claims due rows with `FOR UPDATE SKIP LOCKED` and runs each in its
clinic's tenant transaction. The worker is a second entry point of the API
package (`src/worker/main.ts` → `dist/worker.js`); in development the API starts
it in-process when `WORKER_IN_API=true`.

---

## 2. Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@skincrm/config` | Parse and validate environment once; refuse unsafe production config | — |
| `@skincrm/contracts` | Domain enums, Zod request/response schemas, RBAC matrix, phone/email normalization and masking | — |
| `@skincrm/security` | Argon2id passwords, opaque token hashing, per-clinic envelope encryption, TOTP, idempotency keys | config |
| `@skincrm/db` | Drizzle schema, migrations, RLS policies, tenant-scoped query helpers, seed | config, contracts, security |
| `@skincrm/connectors` | Adapter interfaces plus `mock` and `live` implementations for email, WhatsApp, Meta, Google, calendar | config, contracts |
| `apps/api` | HTTP surface, auth, capability checks, webhooks, audit, and the background worker | all packages |
| `apps/web` | UI | config, contracts |

### Module resolution

Packages export their **TypeScript source**, not a build artifact
(`"main": "./src/index.ts"`). Relative imports are written **without a file
extension**, and `tsconfig.base.json` uses `moduleResolution: "Bundler"`.

This is deliberate. NodeNext would require `.js` specifiers that only resolve
after a compile step, which breaks `drizzle-kit`'s config loader and the `tsx`
scripts. Every consumer here understands extensionless imports: tsx and Vitest
(esbuild), Next.js via `transpilePackages`, and tsup for the api/worker builds.

**Do not add `.js` extensions to relative imports.**

---

## 3. Multi-tenancy — the most important section

Every clinic is a tenant. One deployment serves all of them.

### The mechanism

1. Every tenant-scoped table carries a non-nullable `clinic_id`.
2. The application connects as **`skincrm_app`**: not a superuser, not the table
   owner, without `BYPASSRLS`.
3. Migrations connect as the owner role (`DATABASE_URL`). The app and worker
   connect as `skincrm_app` (`DATABASE_APP_URL`).
4. Every table has RLS **enabled and forced**. `FORCE ROW LEVEL SECURITY`
   matters: without it, the table owner bypasses policies, which would silently
   disable isolation if the app ever connected as the owner.
5. Each request opens a transaction and sets the tenant:

```ts
await withTenant(clinicId, async (tx) => {
  // Every query on tx is confined to this clinic by Postgres itself.
});
```

`withTenant` calls `set_config('app.clinic_id', <uuid>, true)`. The `true` makes
it **transaction-local**, so it cannot leak to the next borrower of a pooled
connection. There is a test for exactly that.

6. Policies compare `clinic_id` to `app_current_clinic_id()`, which is
   `nullif(current_setting('app.clinic_id', true), '')::uuid`.

### Why this fails closed

With the setting unset, `app_current_clinic_id()` returns NULL, the comparison is
NULL, and the row is filtered out. **A forgotten `where clinicId = ...` returns
nothing rather than another tenant's data.** That is the whole point: the
dangerous mistake becomes an obvious empty list instead of a silent breach.

### Rules

- **Never** use `getOwnerDb()` on a path that serves a user request.
- Genuinely cross-tenant work (login lookup by email, webhook routing to a
  clinic, operator tooling) goes through `withoutTenantScope(reason, fn)`, which
  requires a written reason and is easy to grep in review.
- Adding a tenant table means adding its name to the `tenant_tables` array in
  `packages/db/sql/900_rls.sql`. That file is re-applied on every
  `pnpm db:migrate`, so a new table cannot be left unprotected — but only if you
  add it to the list. **This is the single easiest way to introduce a data
  breach in this codebase.**

  You do not have to rely on remembering. The RLS suite discovers every table
  with a `clinic_id` from the Postgres catalog and fails if any lacks enforced
  RLS and a policy, naming the table and the file to fix. It was verified by
  creating an unprotected table and watching it fail.
- `clinics` is keyed by `id`, not `clinic_id`, and has its own policy.

### Privilege restrictions beyond RLS

| Table | Restriction | Why |
|---|---|---|
| `audit_events` | No `UPDATE`, no `DELETE` for the app role | Append-only. A compromised app process cannot rewrite history (PRD AUD-01). |
| `clinics` | No `INSERT`, no `DELETE` for the app role | Provisioning a tenant is an operator action, not an API call. |

Tests: `packages/db/src/__tests__/rls.test.ts`.

---

## 4. Data model

Logical entities from PRD section 5. Built tables are marked; the rest are
planned in the phase noted.

### Built (phase 1 — tenancy and auth)

| Table | Notes |
|---|---|
| `clinics` | Tenant root. Timezone, country, postal address, sending domain, SLA minutes, quiet hours, `promotional_sending_approved`, `hipaa_status`. |
| `branches` | Optional per-branch timezone override. |
| `users` | Role, status, Argon2id hash, encrypted TOTP secret, granted capability overrides, lockout counters, `session_epoch`. |
| `user_branches` | Branch membership. No rows means every branch. |
| `sessions` | Opaque token stored only as a SHA-256 hash, sliding idle timeout, `session_epoch` for mass revocation. |
| `auth_tokens` | Single-use invite / password-reset / verify tokens, hashed. |
| `mfa_recovery_codes` | Hashed one-time codes. |
| `pipeline_stages` | Per-clinic renameable stages, each pinned to a stable `stage_category`. |
| `audit_events` | Append-only. Redacted change summary only. |

### Built (phase 2 — core CRM)

| Table | Notes |
|---|---|
| `people` | `phone_e164` + the original string, normalized email, preferred contact, restricted demographic fields. Matching keys are indexed but **not** unique: a possible duplicate goes to review rather than being rejected. |
| `general_notes` | Belongs to the **person**, so it follows them across every inquiry. Pinnable, archived not deleted, author denormalized so it reads correctly after that account is archived. |
| `consent_records` | Append-only. Current state is the newest row per (person, channel, purpose), computed on read. |
| `person_merges` | Snapshot of exactly what each merge moved, so it can be reversed. |
| `source_submissions` | Every inbound submission, with full attribution columns. Partial unique index on `(clinic_id, platform, external_id)` where the external id is not null — the idempotency backbone for phase 7. |
| `raw_payloads` | Encrypted provider payloads with their own retention column, kept out of ordinary queries. |
| `leads` | Person, submission, source (immutable) plus an optional corrected `reporting_source`, stage, owner, branch, and write-once milestone timestamps. |
| `lead_stage_events` | Every transition with actor, time and reason. |
| `activities` | The unified timeline. |
| `tasks` | Due time, owner, priority, mandatory completion outcome, `snoozed_from`. |

### Built (phase 3 — calendar)

| Table | Notes |
|---|---|
| `consultation_types` | Duration, buffer, eligible staff, and a generic `public_label` so a reminder need not disclose the service. |
| `working_hours` | Per staff, or clinic-wide when `user_id` is null. Stored as **clinic-local wall-clock time**, so "we open at nine" survives a daylight-saving change — a stored UTC time would not. |
| `appointments` | UTC start/end, status independent of lead stage, change reason, reschedule chain. The reserved range includes the buffer. |

Two constraints live in `packages/db/sql/920_constraints.sql`, re-applied on every
migrate because Drizzle cannot express them:

```sql
exclude using gist (staff_user_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status not in ('canceled', 'rescheduled'))
```

That is the double-booking guard (PRD CAL-03). It is a database constraint and
not an application check on purpose: two receptionists booking the same slot in
the same moment would both read it as free, and the second write would succeed.
Postgres refuses it. The API only translates error `23P01` into a 409. There is
a test that inserts directly, bypassing the API, to prove the guarantee holds
without application help.

`assignment_rules` (phase 2) carries a unique `(clinic_id, priority)` for the
same reason: deterministic evaluation order is a requirement, so the database
enforces it rather than a convention.

### Built (phase 4 — messaging)

| Table | Notes |
|---|---|
| `message_templates` | `classification` is the load-bearing field: operational and promotional have different legal bases, consent and content requirements. `version` bumps on every copy change so a sent message can still be explained against the text it came from. Editing a WhatsApp template returns it to `draft`, because the edit invalidates Meta's approval. |
| `messages` | The delivery log. Every outcome including `suppressed`, with the reason. Unique on `(clinic_id, idempotency_key)`. |
| `suppressions` | Hard blocks — bounce, complaint, unsubscribe. Separate from the consent ledger: consent is what they agreed to, this is what happened afterwards. |

### Planned
| `templates` | 4 | Channel, classification (operational/promotional), approved variables, version. |
| `automation_rules`, `enrollments`, `jobs` | 4 | Trigger, conditions, schedule, stop conditions, idempotency key. |
| `messages` | 4 | Rendered content + template version, recipient, provider id, delivery state, suppression reason. |
| `whatsapp_accounts`, `whatsapp_conversations`, `whatsapp_messages` | 5 | Encrypted credential reference, assignment, referral context, last inbound timestamp; unique provider message id. |
| `integration_connections`, `integration_events` | 7 | Encrypted credentials, mapping, health, retry metadata. |
| `conversion_feedback_rules`, `conversion_feedback_events` | 8 | Mapped milestone, approved field set + version, approval status, CRM transition id, destination, event id, send/accept/reject state. |

### Conventions

- Primary keys are UUIDs from `gen_random_uuid()`.
- All instants are `timestamptz`, stored UTC, displayed in the clinic timezone.
- Phones normalized to E.164; **the original string is always kept** for audit.
- Soft delete via `archived_at`. Hard delete only for a valid deletion request.
- Enums are generated from the arrays in `packages/contracts/src/enums.ts`, so a
  value cannot exist in TypeScript without existing in Postgres. Add a value
  there, then `pnpm db:generate`.

---

## 5. Ingest pipeline

Every inbound source event follows the same path (PRD 7):

```
receive → authenticate/verify → persist raw event → acknowledge (200)
   → enqueue → normalize → dedupe (platform, external_id) → match person
   → create/update lead → assign by rule → emit domain event → evaluate automations
```

Rules:

- **The webhook response never waits on sending.** Acknowledge, then enqueue.
- Deduplication is a unique index on `(platform, external_id)`, not application
  logic. A redelivered webhook hits the constraint and is recorded as
  `duplicate`.
- A genuine second submission from the same person is a **new
  `source_submission` and a new `lead`**, sharing the existing `person`.
- Failed jobs use bounded retry and land in a dead-letter view an admin can see
  and replay. Replay is idempotent — it must not create a second lead.
- Every event carries a correlation id, provider event id, status, attempt count
  and a **safe** error summary. No personal data in logs, ever.

---

## 6. Send safety

**Implemented in `apps/api/src/messaging/send-gate.ts` as a single
`evaluateSend` function.** Every send path goes through it, and it runs
**immediately before sending**, never when the message was scheduled — consent,
lead stage, template approval and the service window can all change in between.

In order:

1. `OUTBOUND_SENDING_ENABLED` — the global kill switch, checked first so
   nothing below can override it.
2. A destination exists for that channel.
3. The idempotency key is unused. The unique index is the real guard; this
   turns a would-be constraint violation into a recorded outcome.
4. Promotional only: the clinic has `promotional_sending_approved`, and for
   email a postal address on file.
5. No hard suppression on the destination.
6. Consent for that exact (channel, purpose). Operational may proceed on an
   unrecorded consent; promotional requires an explicit `granted`.
7. Lead state — a closed lead receives no promotional contact.
8. The template is active, and for a Meta template, still `approved`.
9. WhatsApp: inside the 24-hour service window, unless sending an approved
   Meta template. Keyed on the provider template name, not on whether a CRM
   template row exists — a row with no provider name is free-form copy.
10. Quiet hours, in the clinic's timezone, handling a window crossing midnight.
11. Per-contact frequency cap over 24 hours.

Anything blocked returns a `SuppressionReason` and is **written to the delivery
log with that reason**, never dropped. The message row is inserted *before* the
provider is called, so the idempotency key is already claimed if the process
dies mid-send.

## 6a. Automations

Code: `apps/api/src/automations/` (engine, routes, system context),
`apps/api/src/worker/` (claim loop), schema `packages/db/src/schema/automations.ts`,
contracts `packages/contracts/src/automations.ts`, UI `apps/web/src/app/(app)/automations/`.

- **Rule** (`automation_rules`) = one trigger + ordered steps + stop conditions,
  JSON validated by `saveAutomationSchema`. New rules start **paused**. Saving
  bumps `version`. Deleting archives.
- **Triggers** are emitted by `emitAutomationEvent()` from the code that causes
  them, inside that request's transaction: lead creation (both `POST /leads` and
  the intake pipeline), `changeStage`, and the appointment book / reschedule /
  cancel / status routes. **If you add a new way to create a lead or change an
  appointment, emit the event there too.**
- **Enrollment** (`automation_enrollments`) is unique on `(rule_id, dedupe_key)`
  — `lead:<id>` or `appt:<id>` — so replays and ping-pong rules cannot enroll
  twice. It snapshots the steps (D-60).
- **Running**: `runEnrollment()` re-checks stop conditions before every step,
  then executes until a Wait or the end. Sends go through `sendMessage()` and so
  the full send gate; idempotency key `auto:<run>:<step>`. Quiet hours
  reschedule the run (D-61). A blocked send is recorded and the run continues; a
  failed "Only continue if" stops it.
- **Appointment runs** stop when the appointment leaves the state that started
  them (a reminder for a cancelled appointment), and cancel/reschedule stop them
  eagerly. Reminders (`appointment_upcoming`) start `hoursBefore` ahead, or now
  if booked at shorter notice.
- **System context**: background code calls `runAsSystem(clinicId, fn)` which
  opens `withTenant` and a request context with no user and **no capabilities**.

---

## 6b. Shared inbox, Notes and Activity

- **Inbox** (`apps/api/src/inbox/`): `conversations` (one per person per
  channel) + `conversation_notes`; messages stay in `messages` with
  `conversation_id` (D-64). `sendMessage()` attaches every WhatsApp send to the
  thread via `ensureConversation()`; `touchConversation()` maintains preview,
  unread count and `last_inbound_at` (the 24-hour window).
  `receiveInboundWhatsApp()` is the single entry for inbound messages —
  idempotent on the provider id, unknown numbers go through intake. Today it is
  called by `POST /inbox/simulate` (mock connector only); phase 7 wires the Meta
  webhook to it.
- **Notes / Activity** (`apps/api/src/workspace/routes.ts`): read-only feeds over
  `general_notes` and `activities`, joined to people; see D-67 for visibility.
  `from`/`to` are whole days in the clinic time zone (`calendar/timezone.ts`).
  The web pages share `components/feed-filters.tsx` (all filters in the URL,
  applied on submit) and `components/feed-group.tsx` (group headings) — D-83.
- **Unsubscribe** (`apps/api/src/messaging/unsubscribe-routes.ts`): public, token
  is the authority, uses `runAsSystem`. Fastify `maxParamLength` is raised to
  600 because the tokens are ~160 characters.

---

## 6c. Integrations (ad leads, WhatsApp Cloud) and reporting

- **Connections** (`integration_connections`, RLS): one row per connected
  account; `external_account_id` (page id / phone-number id / SHA-256 of the
  Google key) is globally unique per provider and is how a webhook finds its
  clinic. Secrets encrypted with `encryptForClinic`, never serialized.
- **Webhooks** (`apps/api/src/integrations/webhooks.ts`): `/webhooks/meta`,
  `/webhooks/whatsapp` (GET handshake + POST), `/webhooks/google/lead-form`.
  Meta signature = HMAC-SHA256 of the raw body with `META_APP_SECRET` (the JSON
  parser in `app.ts` keeps `request.rawBody`). Unsigned calls are accepted only
  outside production when no secret is set.
- **Queue** (`inbound_events`, encrypted payload, idempotent per provider id):
  `processDueInboundEvents()` in the worker loop, before automations. Meta leads
  are fetched with the page token (`LiveMetaLeadsConnector`), answers mapped by
  `personFromAnswers()`, then `ingestSubmission()`. Exponential backoff, 6 tries.
- **WhatsApp sending** is per clinic: `whatsappConnector()` in
  `integrations/connections.ts` returns the mock, or a `WhatsAppCloudConnector`
  built from the clinic's connection. Template parameters are the variables in
  the order the body uses them.
- **Reporting** (`apps/api/src/reports/routes.ts`): funnel from each lead's
  furthest stage in history plus write-once milestones; excludes test leads;
  CSV export audited, personal columns only with `people:read`. Page at
  `/reports`, in the nav behind `reports:read` (D-72).

---

## 6d. SLA, staff alerts and operations

- **SLA** (`apps/api/src/leads/sla.ts`): `sla_due_at` set on lead creation from
  `clinics.first_response_sla_minutes`; `markFirstResponse()` is called from
  contact attempts, `changeStage` and `sendMessage` (people only, never
  automations). `processSlaBreaches()` runs in the worker loop.
- **Staff alerts**: automation step `notify_team` → `sendSystemEmail` (D-74).
- **Operations** (`apps/api/src/ops/monitor.ts`): heartbeats, alert collection,
  retention; `ops_heartbeats` is owner-only (revoked from the app role).
- **Deployment** (`deploy/`): one Dockerfile with `api`, `web`, `tools`
  targets; `docker-compose.prod.yml`; `Caddyfile`. Web uses Next standalone output.
- **Backups** (`scripts/`): `backup.sh`, `restore.sh`, `verify-backup.sh`,
  sharing `scripts/lib/pg.sh` (reads `.env` as data, finds the Postgres
  container itself; D-86).
- **Readiness** `/health/ready` is 503 when the database or worker is down;
  `/health` is liveness only (D-85).
- **Contact fields** (D-89): one rule set in `packages/contracts/src/contact.ts`
  (API schemas) and `apps/web/src/components/contact-inputs.tsx` (Phone/Email/Name
  inputs). Staff-typed data is strict (`assertRealPhone` in people/service.ts);
  `intake/pipeline.ts` is forgiving and never drops an outside lead.
- **Connect WhatsApp** (`integrations/oauth.ts`, `/integrations/whatsapp/signup/*`;
  browser side `settings/integrations/whatsapp-connect.tsx`) — D-88.
- **Connect with Facebook / Google** (`integrations/oauth.ts`): start → provider sign-in → web callback route → pending choice (encrypted, one-time) → complete. States and pending ids are hashed rows in `auth_tokens` (D-87).
- **New tenants** `pnpm db:create-clinic` → `packages/db/src/provision.ts` (D-84).

---

## 7. Conversion feedback (CRM → ad platform)

Code: `apps/api/src/feedback/` (service + routes), adapters in
`packages/connectors/src/meta/capi.ts` and `google/data-manager.ts`, UI at
`/settings/feedback`.

- `changeStage` → `createFeedbackCandidates()` for each milestone first stamped
  (Qualified and Booked together, D-63), only for reviewed, unpaused destinations
  with that milestone mapped. Match key from the lead's source submission: Meta lead
  id, WhatsApp referral id (opt-in), or gclid; none → `unmatched`; test lead → `blocked`.
- Worker `processFeedbackOutbox()` claims `queued` rows (SKIP LOCKED), re-runs
  `feedbackGate()`, builds the allowlisted payload, sends via the adapter, and
  records `accepted` / retries with backoff / `rejected`.
- Pause and revoke cancel queued rows; unmapping a milestone cancels its queue.
- The ops monitor alerts on rejections (`feedback_rejected`).

## 8. Authentication and authorization

- **Sessions** are server-side. The cookie holds 256 bits of random; only its
  SHA-256 hash is stored, so reading the database does not yield a usable
  credential. `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Mass revocation** uses `users.session_epoch`. Bump it on password change,
  role change or suspension and every existing session for that user is rejected.
  Always through `revokeAllSessionsForUser()`, which joins the request's
  transaction when there is one — a separate transaction deadlocks against the
  request's own row lock (D-82).
- **Removing staff:** Archive = suspend + hide (reversible); Delete = permanent,
  non-admins only, refused if they have appointments (D-81). Neither may leave a
  clinic without an active admin.
- **Passwords** are Argon2id (19 MiB, 2 passes). Cost parameters live in the hash,
  so raising them later triggers a transparent rehash on next login.
- **Enumeration resistance:** a missing account still burns an Argon2
  verification, so response timing does not reveal whether an email exists.
- **MFA** is TOTP with a ±1 window, and the accepted counter is stored so a code
  cannot be replayed inside its window. Recovery codes are hashed and single-use.
- **Authorization is capability-based.** `packages/contracts/src/permissions.ts`
  maps each role to a capability set; routes declare the capability they need.
  Adding a role means filling one column, not auditing every route.
- **Two further layers** beyond the capability check:
  - `FIELD_VISIBILITY` strips fields a role may not see even on a readable row.
  - `leadVisibilityScope` narrows the query itself, so a practitioner's list is
    filtered in SQL rather than in the UI.
- A marketing analyst has **no** `people:read` and **no** `leads:read`, so no
  route can hand them a personal record even by mistake.

### Envelope encryption

Per-clinic provider credentials, TOTP secrets and raw payloads use AES-256-GCM
with a key derived per clinic via HKDF, and the **clinic id bound as additional
authenticated data**. A ciphertext copied from clinic A's row into clinic B's row
fails to decrypt rather than silently yielding A's secret. Production requires a
KMS; `CRYPTO_PROVIDER=local` is refused at boot.

---

## 8a. The API route contract

Routes are **never** registered on Fastify directly. They go through
`registerRoute` in `apps/api/src/route.ts`, which is the one place every
cross-cutting concern attaches:

```ts
registerRoute(app, {
  method: "GET",
  url: "/leads/:id",
  auth: { capability: "leads:read" },   // or `auth: false` for public routes
  params: z.object({ id: uuidSchema }),
  handler: async ({ params }) => {
    const tx = getTx();               // tenant-scoped transaction, always present
    // ...
  },
});
```

In order, per request, it:

1. Creates a correlation id and the `AsyncLocalStorage` request context.
2. Validates body, query and params against the Zod schemas, before any auth work.
3. Resolves the session cookie, clearing a cookie that no longer resolves.
4. Checks the declared capability against the caller's resolved set.
5. Opens `withTenant(clinicId, …, { actorUserId })` and puts the transaction in
   the context.
6. Runs the handler, serializes the result, logs one structured line.

**Why a helper instead of middleware:** there is no way to write a handler that
touches tenant data outside a tenant transaction. `getTx()` only resolves inside
one and throws otherwise, and services have no other handle to reach for. A new
endpoint cannot silently skip tenancy or authorization.

Consequences to know about:

- **One transaction per request.** This gives atomicity and RLS together, but a
  slow handler holds a connection. Long-running work (CSV import, backfill) must
  not use this path; it belongs in a worker job that opens its own `withTenant`
  per unit of work.
- **404, not 403, for another tenant's record.** RLS hides the row, so the lookup
  simply misses. That is deliberate: confirming a record exists but is off-limits
  is itself a disclosure.
- **Rate limiting runs in `onRequest`,** before the body is parsed, so a
  rate-limit `keyGenerator` cannot read the request body. Credential endpoints are
  therefore capped per IP, and per-account protection comes from the login
  lockout instead. See decision D-25.

## 9. Conventions

- **Errors** use one envelope: `{ error: { code, message, details?, correlationId? } }`.
  `details` is keyed by dotted field path.
- **Validation** is Zod at the boundary. Contract schemas are shared between API
  and web, so a field cannot drift between them.
- **Logging** is structured. Never log contact details, note bodies, message
  bodies, tokens or raw payloads. Log ids and correlation ids instead.
- **Timezones:** compute in UTC, display in the clinic timezone. Daylight-saving
  transitions are a correctness requirement, not an edge case (PRD CAL-01).
- **Migrations** are generated, never hand-written. Run `pnpm db:generate` after
  a schema edit and commit the generated SQL.
- **Tests** live beside the code in `src/__tests__/`. Database tests run against
  the real Postgres from docker-compose with `fileParallelism: false`.

---

## 10. Build status

| Area | State |
|---|---|
| Monorepo, docker-compose, env config | ✅ Built |
| Drizzle schema — tenancy, auth, pipeline stages, audit | ✅ Built |
| Row-level security + isolation test suite (12 tests) | ✅ Built and passing |
| Security primitives — passwords, tokens, encryption, TOTP | ✅ Built |
| RBAC capability matrix and field masking | ✅ Built |
| Seed data, two clinics | ✅ Built |
| `apps/api` — Fastify bootstrap, route contract, audit service, logging | ✅ Built |
| Auth routes, MFA, lockout, sessions `[ID-01]` | ✅ Built, 34 tests |
| User administration and branch assignment | ✅ Built |
| `apps/web` — shell, sign-in, role-aware nav, staff admin | ✅ Built |
| People, duplicates, merge, General Notes, consent `[ID-02, ID-06, ID-08, MSG-04]` | ✅ Built, 26 tests |
| Leads, pipeline, timeline, tasks `[LEAD-01, 02, 04, 05, 06]` | ✅ Built, 29 tests |
| Walk-in / manual intake `[ID-03]` | ✅ Built |
| Assignment rules `[LEAD-03]` | ✅ Built |
| CSV import and website endpoint `[ID-04, ID-05, ID-07]` | ✅ Built |
| Phase 2 UI — leads, Kanban, lead detail, people, duplicates | ✅ Built |
| Calendar API — types, hours, booking, reschedule, availability `[CAL-01…04]` | ✅ Built, 25 tests |
| Calendar UI — day/week views, booking, settings | ✅ Built |
| Connectors package with email and WhatsApp mocks | ✅ Built |
| Templates, send gate, delivery log `[MSG-02, 04, 05, 06, 07]` | ✅ Built, 31 tests |
| Six-stage pipeline and migration of existing clinics (D-57) | ✅ Built |
| Automation engine, stop conditions, reminders `[MSG-03, MSG-06, CAL-05]` | ✅ Built, 18 tests |
| Worker (Postgres queue) and session pruning | ✅ Built |
| Automation canvas, recipes, dry run, run history | ✅ Built |
| SMTP email connector; invite and reset emails `[MSG-01]` | ✅ Built (connection-test screen not yet) |
| UI simplification — shell, Add lead, board, stepper | ✅ Built |
| Template editor, sent-messages log, public unsubscribe page `[MSG-02, 04, 07]` | ✅ Built |
| Shared WhatsApp inbox on the mock connector `[WA-01…06]` | ✅ Built, 12 tests (with feeds + unsubscribe) |
| Notes and Activity sections | ✅ Built |
| Calendar time grid, staff day view, phone agenda | ✅ Built |
| Mobile layout across every screen | ✅ Built |
| WhatsApp Cloud API live sender, inbound + status webhooks | ✅ Built (tested with fakes) |
| Meta Lead Ads + Google lead-form ingestion, queue, Settings screen `[INT-01…05]` | ✅ Built, 16 tests |
| Forward-only stages (D-69) | ✅ Built |
| WhatsApp-style inbox | ✅ Built (visual check incomplete — see HANDOFF) |
| Reporting `[REP-01…04]` | ✅ Built, 4 tests, in the nav (D-72) |
| Response-time SLA, escalation, staff email alerts | ✅ Built, 7 tests |
| Lead rules settings (SLA + assignment UI) | ✅ Built |
| Audit log viewer `[AUD-01]` | ✅ Built |
| Monitoring, alerts, retention, health endpoints | ✅ Built, 7 tests |
| CI, production images, compose + HTTPS, backups, restore test | ✅ Built and run |
| Accessibility scan (WCAG 2.2 AA, automated) | ✅ 0 violations |
| Conversion feedback `[FB-01…10]` | ✅ Built, 13 tests (mocks) |
| Notifications, clinic and personal profiles | ✅ Built, 6 tests |
| Light theme only | ✅ |
| Patient edit page (contact, address, city, branch…) | ✅ Built, 1 test |
| Notes / Activity date range + grouping, shared filter panel (D-83) | ✅ Built, 1 test |
| Staff permanent delete, last-admin guard on archive (D-81) | ✅ Built, 4 tests |
| `pnpm db:create-clinic` tenant provisioning (D-84) | ✅ Built, 2 tests |
| Production gate, readiness 503, alert retry (D-85) | ✅ Built, 5 tests |
| Playwright end-to-end (walk-in → book → confirm → won) | ✅ 1 test, in CI |
| KMS-wrapped master key | ⬜ Not started (D-75) |
| Billing / plans / self-serve signup | ⬜ Not started |
| Connect with Facebook / Google Ads (OAuth) `[INT-01, INT-03]` (D-87) | ✅ Built, 7 tests; live Google lead-form update to verify with a real account |
| Connect WhatsApp — Embedded Signup + coexistence `[WA-01, INT-06]` (D-88) | ✅ Built, 4 tests; verify coexistence with the clinic's real number |
| Contact-field validation, staff forms strict / ingestion forgiving (D-89) | ✅ Built, 12 tests |

