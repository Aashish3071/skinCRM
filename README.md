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
| Background jobs | Postgres as the queue (worker in `apps/api/src/worker`, D-59) |
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
| 3 | Calendar — types, booking, conflict prevention, statuses `[CAL-01…05]` | ✅ Complete (reminders via automations) |
| 4 | Messaging core — templates, consent ledger, automations, delivery log `[MSG-01…07]` | 🟡 Engine, worker, canvas builder and SMTP done; template editor + delivery-log screens outstanding |
| 5 | WhatsApp shared inbox `[WA-01…09]` | ⬜ Not started |
| 6 | Reporting and exports `[REP-01…04]` | ⬜ Not started |
| 7 | Real integrations — Meta, Google, WhatsApp Cloud, email `[INT-01…09]` | ⬜ Not started |
| 8 | Conversion feedback — outbox, eligibility gate, adapters `[FB-01…10]` | ⬜ Not started |
| 9 | Hardening, backups, monitoring, deployment guide, 15 UAT scenarios | ⬜ Not started |

### Verify the build yourself

```bash
pnpm typecheck    # clean
pnpm lint         # clean
pnpm test         # 256 tests: 14 RLS isolation, 24 security, 213 API, 5 web
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

### Done in phase 3

- **Consultation types** `[CAL-02]`, per-staff working hours, day and week
  calendar views, and a settings screen for both.
- **Booking** `[CAL-03]` where overlap is refused by a Postgres **exclusion
  constraint**, not an application check — a read-then-write check races. There
  is a test that inserts directly, bypassing the API, to prove it.
- **Reschedule** frees the old row inside the same transaction, so nudging an
  appointment by ten minutes is not blocked by its own original booking.
- **Statuses** `[CAL-04]` independent of lead stage: attending advances the
  lead, cancelling deliberately does not.
- **Timezone handling** `[CAL-01]` through the IANA database, tested either side
  of a daylight-saving change.

### Done in phase 4 so far

- **`packages/connectors`** — adapter interfaces plus mocks for email and
  WhatsApp. The mocks simulate hard bounces and transient failures, because a
  mock that always succeeds hides every retry and suppression path until
  production.
- **Templates** `[MSG-02]` with an operational/promotional classification,
  a validated variable list, versioning on every copy change, and preview.
  Promotional email cannot be saved without an unsubscribe link and a postal
  address.
- **The send gate** `[MSG-04, MSG-05, MSG-06]` — one function checking the kill
  switch, idempotency, clinic promotional approval, hard suppressions, consent
  per (channel, purpose), lead state, template approval, the WhatsApp 24-hour
  service window, quiet hours and a per-contact frequency cap. Called
  immediately before sending, never at schedule time.
- **Delivery log** `[MSG-07]` recording every outcome including the reason a
  message was *not* sent.
- **Unsubscribe** as a stateless signed token, generated by the sender.

### Done in phase 4, second slice

- **Simpler pipeline** — six stages: New → Contacted → Booked → Visited → Won,
  plus Lost. Existing clinics are migrated by
  `packages/db/sql/930_simplify_pipeline.sql` (leads moved, history kept). See D-57.
- **Automation engine** `[MSG-03, MSG-06, CAL-05]` — rules are one trigger plus
  ordered steps (send email, send WhatsApp, wait, create task, move lead, "only
  continue if"). Triggers: new lead, stage change, appointment booked, before an
  appointment, attended, no-show, cancelled. Runs are enrolled in the same
  transaction as the event, stop on reply / booking / conversion / closure,
  wait out quiet hours, retry provider failures, and appointment reminders
  follow reschedules and stop on cancel. Every send still goes through the send gate.
- **Worker** — `apps/api/src/worker/`, Postgres as the queue (`SKIP LOCKED`
  claims). Runs inside the API in development; `node apps/api/dist/worker.js`
  in production. Also prunes expired sessions.
- **Automation canvas** (`/automations`) — Zapier-style vertical flow with "+"
  between steps, a settings panel, five ready-made recipes from PRD 4.4, a
  dry-run "Test" against a real lead, on/off switch, and per-person run history.
- **SMTP email connector** — `CONNECTOR_EMAIL=live` sends through any SMTP relay
  (Mailpit on http://localhost:8025 in development). Invite and password-reset
  emails now go out through it, with `/accept-invite` and `/reset-password` pages.
- **UI simplification** — new shell (icon sidebar, phone tab bar), only working
  sections in the nav, a four-field "Add lead" form, a drag-and-drop pipeline
  board with an accessible "Move…" menu, and a one-tap stage stepper on the lead page.

### Seeing automations send real email locally

Everything stays on your machine. In the root `.env` set
`CONNECTOR_EMAIL=live` and `OUTBOUND_SENDING_ENABLED=true`, restart `pnpm dev`,
turn on an automation, add a lead with an email address, and open Mailpit at
http://localhost:8025. Put both back before pointing at a real relay.

### Next up

1. **Template editor and delivery log screens** — the API exists
   (`/templates`, `/messages`); the Automations area needs a Templates tab with
   preview and a Messages tab showing each send and its suppression reason `[MSG-02, MSG-07]`.
2. **Public unsubscribe page** `/unsubscribe/[token]` — tokens are generated
   (`packages/security/src/unsubscribe.ts`) but nothing serves them yet.
3. **Phase 5 — WhatsApp shared inbox `[WA-01…09]`** on the mock connector.
   Inbound messages will also make the "They reply" stop condition fire.

---

## Repository layout

```
apps/
  api/                 Fastify REST API, webhook receivers, and the background
                       worker (src/worker, a second entry point)
  web/                 Next.js front end
packages/
  config/              Typed environment loading and production safety gate
  contracts/           Shared enums, Zod schemas, RBAC matrix, phone normalization
  db/                  Drizzle schema, migrations, RLS policies, seed, scripts
  security/            Password hashing, tokens, envelope encryption, TOTP
  connectors/          Adapter interfaces, mocks, and the SMTP email connector
docs/
  HANDOFF.md           Resume point for the next session or agent
  decisions.md         Decision log with rationale
PRD.md  BRD.md         Requirements
ARCHITECTURE.md        System design and the rules that must not be broken
```
