# SkinCRM — Clinic Lead & Appointment CRM

A multi-tenant SaaS CRM for clinics. It captures inquiries from Meta lead forms,
click-to-WhatsApp ads, Google Ads lead forms, website forms, CSV imports and
walk-ins; routes them to staff; tracks each one through consultation and
conversion; books appointments; sends consent-aware email and WhatsApp messages;
and reports which sources produce attended appointments.

It is **not** an electronic medical record. There are no prescriptions,
diagnoses, treatment notes or clinical photos anywhere in the product.

Requirements live in [PRD.md](PRD.md) and [BRD.md](BRD.md). Every requirement has
a stable ID (`ID-01`, `LEAD-02`, `WA-06`, `FB-03`, …) used throughout the code,
tickets and tests.

---

## Read this first if you are an AI agent picking up the work

1. **[docs/HANDOFF.md](docs/HANDOFF.md)** — the exact resume point: what is
   half-finished, what to do next, what is known broken.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the system is put together and
   the rules you must not break (tenancy, send safety, the outbox).
3. **[docs/decisions.md](docs/decisions.md)** — why each choice was made, so you
   do not undo a deliberate decision.

Keep all four documents current. A stale doc is treated as a broken build.

---

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, strict mode, ESM |
| Monorepo | pnpm workspaces + Turborepo |
| Web | Next.js (App Router) + React |
| API | Fastify (REST, Zod-validated) — see [decision D-24](docs/decisions.md) for why not NestJS |
| Background jobs | BullMQ on Redis |
| Database | PostgreSQL 16 + Drizzle ORM, row-level security for tenancy |
| Auth | Server-side sessions, Argon2id passwords, TOTP MFA for admins |
| Tests | Vitest (unit + integration), Playwright (end-to-end) |

---

## Running it locally

Prerequisites: Node 22+, pnpm 11+, Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Then open http://localhost:3000. The API is on http://localhost:4000 and Mailpit
(a local mail catcher) on http://localhost:8025.

### Seeded sign-in

All seeded accounts share the password `ChangeMe-Dev-2026!`.

| Email | Role |
|---|---|
| `admin@sunshine-skin.test` | Admin / owner |
| `frontdesk@sunshine-skin.test` | Front desk / counselor |
| `doctor@sunshine-skin.test` | Practitioner |
| `marketing@sunshine-skin.test` | Marketing analyst |

The seed also creates a **second clinic**, *Northside Dermatology*
(`admin@northside-derm.test`). It exists so cross-tenant leakage is visible: if
any Northside row ever appears while signed in to Sunshine Skin, isolation is
broken. Do not delete it.

### Ports

Postgres is on **5433** and Redis on **6380**, deliberately off the defaults so
they cannot collide with an existing local install.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run web, api and worker in watch mode |
| `pnpm build` | Build every package and app |
| `pnpm typecheck` | Type-check the whole workspace |
| `pnpm test` | Run every test suite |
| `pnpm lint` | Lint the whole workspace |
| `pnpm db:generate` | Generate migration SQL from the Drizzle schema |
| `pnpm db:migrate` | Apply extensions, create the app role, migrate, re-apply RLS |
| `pnpm db:seed` | Insert development data (idempotent) |
| `pnpm db:reset` | Drop the schema, then migrate and seed. Development only |
| `pnpm infra:up` / `pnpm infra:down` | Start / stop Postgres, Redis and Mailpit |

**After editing anything in `packages/db/src/schema/`** you must run
`pnpm db:generate` then `pnpm db:migrate`. Never hand-edit a file in
`packages/db/drizzle/`.

---

## Safety switches you need to know about

These default to off and exist because this product handles data that may be
regulated. Do not flip them to ship a feature.

| Variable | Default | Meaning |
|---|---|---|
| `OUTBOUND_SENDING_ENABLED` | `false` | Global kill switch. No email or WhatsApp message leaves the process. |
| `CONVERSION_FEEDBACK_ENABLED` | `false` | Stricter switch for CRM → ad-platform events. Stays off until per-destination eligibility checks pass (PRD FB-03). |
| `CONNECTOR_*` | `mock` | Each integration runs against an in-process mock. The whole app is demoable with no credentials. |

Three rules the code enforces and you must preserve:

1. **General Notes and service/condition details never leave the CRM.** Not to an
   ad platform, not into an automated message, not into a log.
2. **No hashed email or phone is ever uploaded to Google.** Google's
   customer-data policy forbids measuring health or medical conversions with
   enhanced conversions, so contact identifiers are not in the allowlist.
3. **Promotional sending stays off** until a clinic's privacy lead approves the
   copy and legal basis (`clinics.promotional_sending_approved`).

---

## Status

Phases follow PRD section 10. Requirement IDs in brackets.

| # | Phase | State |
|---|---|---|
| 1 | Foundation — monorepo, DB, tenancy, auth, RBAC, audit, seed `[ID-01, AUD-01, SET-01]` | ✅ Complete |
| 2 | Core CRM — people, General Notes, leads, pipeline, tasks, intake, CSV `[ID-02…08, LEAD-01…06]` | ✅ Complete |
| 3 | Calendar — types, booking, conflict prevention, statuses `[CAL-01…05]` | 🟡 API done; reminders need phase 4, UI outstanding |
| 4 | Messaging core — templates, consent ledger, automations, delivery log `[MSG-01…07]` | ⬜ Not started |
| 5 | WhatsApp shared inbox `[WA-01…09]` | ⬜ Not started |
| 6 | Reporting and exports `[REP-01…04]` | ⬜ Not started |
| 7 | Real integrations — Meta, Google, WhatsApp Cloud, email `[INT-01…09]` | ⬜ Not started |
| 8 | Conversion feedback — outbox, eligibility gate, adapters `[FB-01…10]` | ⬜ Not started |
| 9 | Hardening, backups, monitoring, deployment guide, 15 UAT scenarios | ⬜ Not started |

### Verify the build yourself

```bash
pnpm typecheck    # 5 packages, clean
pnpm test         # 183 tests: 14 RLS isolation, 24 security, 145 API integration
```

### Done and verified in phase 1

- pnpm + Turborepo monorepo; `docker compose` brings up Postgres 16, Redis 7 and Mailpit.
- Typed environment config with a production safety gate that refuses dev placeholders.
- Drizzle schema for clinics, branches, users, branch membership, sessions, auth
  tokens, MFA recovery codes, pipeline stages and the audit trail.
- **Multi-tenant isolation enforced by Postgres row-level security**, with
  `FORCE ROW LEVEL SECURITY` and a non-owner application role. 12 integration
  tests cover fail-closed reads, cross-tenant read and write attempts,
  transaction-scoped tenant settings, the append-only audit trail, and the
  refusal to create clinics from the app. Run them with
  `pnpm --filter @skincrm/db test`.
- Security primitives: Argon2id password hashing with transparent rehash,
  SHA-256 hashed opaque tokens, per-clinic envelope encryption (AES-256-GCM with
  an HKDF-derived key and the clinic id bound as authenticated data), TOTP with
  replay rejection, and the outbound idempotency-key builder.
- Capability-based RBAC matrix for the four roles, plus per-role field masking.
- Idempotent seed with two clinics so isolation is testable by hand.
- **`apps/api` (Fastify)** — a single `registerRoute` helper attaches correlation
  id, request context, session resolution, capability check, the tenant
  transaction and Zod validation, so none of them can be forgotten on a new
  endpoint. Structured logging with a redaction list, one error envelope, and an
  append-only audit service that strips personal data from change summaries.
- **Auth `[ID-01]`** — login with per-account lockout and timing-equalized
  failure, logout, session read, password reset, change password, TOTP MFA with
  single-use recovery codes, and staff invite/accept. Sessions are opaque tokens
  stored as hashes, with sliding idle expiry and epoch-based mass revocation.
- **User administration** — invite, update, archive, branch assignment, with
  guards against demoting the last admin, changing your own role, or granting a
  non-delegatable capability. A role or status change revokes that user's
  sessions immediately.
- **34 API integration tests**, including the permission half of PRD UAT
  scenario 9 and cross-tenant attempts over real HTTP.

### Done in phase 2

- **Core CRM schema** and the People API: E.164 normalization keeping the
  original, duplicate detection answering 409 with candidates, a review queue,
  and a reversible merge `[ID-02, ID-06]`.
- **General Notes** `[ID-08]` — person-level, pinnable, archived not deleted,
  and provably absent from the audit trail.
- **Consent ledger** `[MSG-04]` — append-only per (channel, purpose).
- **Leads and pipeline** `[LEAD-01, 02, 04, 05, 06]` — stage machine with
  required exit reasons and write-once milestones, unified timeline, contact
  attempts, tasks with mandatory outcomes.
- **Assignment rules** `[LEAD-03]` — deterministic priority order, source /
  service / branch conditions, named assignee or round-robin, falls through
  when the target is inactive, dry-run preview.
- **Intake** `[ID-04, ID-05, ID-07]` — one shared pipeline (persist, dedupe,
  match, create, route) behind CSV import and the public website endpoint.
  Deduplication is a unique index, so re-importing a file imports nothing twice.
- **UI** — leads list and Kanban, lead detail with timeline and tasks, People
  search and profile, duplicate review, and a Home wired to live counts.

### Done in phase 3 so far

- **Consultation types** `[CAL-02]` with duration, buffer and eligible staff,
  plus per-staff working hours stored as clinic-local wall-clock time.
- **Booking** `[CAL-03]` where overlap is refused by a Postgres **exclusion
  constraint**, not an application check — a read-then-write check races, and
  two receptionists booking the same slot would both succeed. Reserved time
  includes the buffer. Cancelled and rescheduled rows free their slot.
- **Reschedule** frees the old row inside the same transaction, so nudging an
  appointment by ten minutes is not blocked by its own original booking.
- **Statuses** `[CAL-04]` independent of lead stage: attending advances the lead,
  cancelling deliberately does not touch it.
- **Availability** computed from working hours minus existing bookings.
- **Timezone handling** `[CAL-01]` through the IANA database, with tests that
  pin behaviour either side of a daylight-saving change.

### Next up

1. **Calendar UI `[CAL-01]`** — day and week views by staff and branch, a
   booking dialog driven by the availability endpoint, and reschedule/cancel
   with the reason captured.
2. **Phase 4 — messaging core `[MSG-01…07]`**: provider interfaces plus mocks,
   templates with classification, the automation engine, and the delivery log.
   This is also what finally sends the invite and password-reset emails, and
   what schedules and invalidates appointment reminders `[CAL-05]`.
3. **`apps/worker`** — the first BullMQ processors arrive with phase 4.

---

## Repository layout

```
apps/
  api/                 Fastify REST API and webhook receivers
  web/                 Next.js front end
  worker/              BullMQ job processors
packages/
  config/              Typed environment loading and production safety gate
  contracts/           Shared enums, Zod schemas, RBAC matrix, phone normalization
  db/                  Drizzle schema, migrations, RLS policies, seed, scripts
  security/            Password hashing, tokens, envelope encryption, TOTP
  connectors/          Adapter interfaces plus mock and live implementations
                       (planned, phase 4)
docs/
  HANDOFF.md           Resume point for the next session or agent
  decisions.md         Decision log with rationale
PRD.md  BRD.md         Requirements
ARCHITECTURE.md        System design and the rules that must not be broken
```
