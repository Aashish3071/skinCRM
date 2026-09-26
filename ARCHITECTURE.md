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
                    └──┬────────┬──┘
                       │        │ BullMQ
             ┌─────────▼──┐  ┌──▼──────────────┐
             │ PostgreSQL │  │  apps/worker    │  ingest, automation sends,
             │  (RLS)     │◀─│                 │  feedback outbox, reconcile
             └────────────┘  └─────────────────┘
```

Three processes, one database. The API never does slow work inline: a webhook
verifies, writes the raw event, returns 200, and enqueues. The worker does the
rest.

---

## 2. Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@skincrm/config` | Parse and validate environment once; refuse unsafe production config | — |
| `@skincrm/contracts` | Domain enums, Zod request/response schemas, RBAC matrix, phone/email normalization and masking | — |
| `@skincrm/security` | Argon2id passwords, opaque token hashing, per-clinic envelope encryption, TOTP, idempotency keys | config |
| `@skincrm/db` | Drizzle schema, migrations, RLS policies, tenant-scoped query helpers, seed | config, contracts, security |
| `@skincrm/connectors` | Adapter interfaces plus `mock` and `live` implementations for email, WhatsApp, Meta, Google, calendar | config, contracts |
| `apps/api` | HTTP surface, auth, capability checks, webhooks, audit | all packages |
| `apps/worker` | Queue processors | all packages |
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

### Planned
| `appointments` | 3 | UTC start/end, status independent of lead stage, change reason. Overlap prevented by an exclusion constraint. |
| `consultation_types` | 3 | Duration, buffer, eligible staff. |
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

Any outbound message obeys all of this, checked **immediately before send** by
the worker, not when the job was scheduled:

1. Global `OUTBOUND_SENDING_ENABLED` is on.
2. Consent exists for that (channel, purpose). Operational and promotional are
   separate; email and WhatsApp are separate.
3. For promotional: the clinic has `promotional_sending_approved`, and the
   template carries sender identity, postal address and an unsubscribe
   mechanism.
4. No opt-out or suppression for that channel.
5. Lead stage, appointment state and rule status are re-read — a lead that
   booked, replied, converted, opted out or closed stops the send.
6. Quiet hours and per-contact frequency cap allow it.
7. For WhatsApp: either inside the 24-hour service window (free-form allowed) or
   using a currently **approved** template. A paused or rejected template can
   never be sent.
8. The idempotency key `(person, rule, trigger event, schedule instance,
   channel)` has not been used. It is a unique index.

Anything blocked is **recorded with a `suppression_reason`**, never dropped
silently. The delivery log shows scheduled, queued, sent, delivered, bounced,
failed, canceled and suppressed states with reasons.

---

## 7. Conversion feedback (CRM → ad platform)

The highest-risk feature in the product. Architecture reflects that.

- **Transactional outbox.** A milestone transition writes a candidate row in the
  same transaction as the stage change. The worker sends from the outbox. One
  transition produces exactly one candidate per destination; retries reuse the
  event id, so a replay cannot double-count a conversion.
- **Default off.** `CONVERSION_FEEDBACK_ENABLED=false` globally, and each
  destination starts at eligibility state `unreviewed`. Production sending
  requires `approved_production`.
- **Field allowlist, not a denylist.** Only the milestone event and the
  identifiers in `FEEDBACK_MATCH_KEYS` may be transmitted. Service, condition,
  diagnosis, treatment details, note text and arbitrary CRM fields are denied by
  construction.
- **No hashed contact identifiers for Google.** Google's customer-data policy
  says health or medical conversions cannot be measured with enhanced
  conversions. Hashing does not remove a health-data restriction, so hashed
  email and phone are not in the allowlist at all.
- **Preview and test mode.** An admin sees the exact event category, timestamp,
  destination and identifiers, with personal values masked, before anything is
  enabled. Test mode cannot silently promote itself to production.
- **Kill switch.** One action stops all sends, and queued unsent events are
  canceled rather than left pending.
- **CRM reporting is independent.** A rejected or unmatched platform event is
  still visible in the CRM and is never counted as a platform-reported
  conversion. Sending events does not change campaign bidding; that remains a
  deliberate action in the ad account.

---

## 8. Authentication and authorization

- **Sessions** are server-side. The cookie holds 256 bits of random; only its
  SHA-256 hash is stored, so reading the database does not yield a usable
  credential. `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Mass revocation** uses `users.session_epoch`. Bump it on password change,
  role change or suspension and every existing session for that user is rejected.
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
| Assignment rules `[LEAD-03]` | 🔜 Next (manual assignment works; rule engine outstanding) |
| CSV import and website endpoint `[ID-04, ID-05]` | 🔜 Next |
| Phase 2 UI — leads, people, timeline | 🔜 Next |
| Calendar `[CAL-01…05]` | ⬜ Phase 3 |
| Templates, consent ledger, automations `[MSG-01…07]` | ⬜ Phase 4 |
| WhatsApp shared inbox `[WA-01…09]` | ⬜ Phase 5 |
| Reports and exports `[REP-01…04]` | ⬜ Phase 6 |
| Meta / Google / WhatsApp adapters `[INT-01…09]` | ⬜ Phase 7 |
| Conversion feedback outbox and gate `[FB-01…10]` | ⬜ Phase 8 |
| Backups, monitoring, deployment guide, UAT | ⬜ Phase 9 |
