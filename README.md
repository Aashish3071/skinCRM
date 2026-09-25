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
| API | NestJS (REST, Zod-validated) |
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
| 1 | Foundation — monorepo, DB, tenancy, auth, RBAC, audit, seed `[ID-01, AUD-01, SET-01]` | 🟡 In progress |
| 2 | Core CRM — people, General Notes, leads, pipeline, tasks, intake, CSV `[ID-02…08, LEAD-01…06]` | ⬜ Not started |
| 3 | Calendar — types, booking, conflict prevention, statuses `[CAL-01…05]` | ⬜ Not started |
| 4 | Messaging core — templates, consent ledger, automations, delivery log `[MSG-01…07]` | ⬜ Not started |
| 5 | WhatsApp shared inbox `[WA-01…09]` | ⬜ Not started |
| 6 | Reporting and exports `[REP-01…04]` | ⬜ Not started |
| 7 | Real integrations — Meta, Google, WhatsApp Cloud, email `[INT-01…09]` | ⬜ Not started |
| 8 | Conversion feedback — outbox, eligibility gate, adapters `[FB-01…10]` | ⬜ Not started |
| 9 | Hardening, backups, monitoring, deployment guide, 15 UAT scenarios | ⬜ Not started |

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

### Next up

1. `apps/api` — NestJS bootstrap, request context (tenant + actor), the
   `withTenant` interceptor, capability guard, Zod validation pipe, audit
   service, and the error envelope.
2. Auth routes: login (with MFA challenge), logout, session read, password reset,
   change password, MFA enrolment, user invite and accept `[ID-01]`.
3. `apps/web` — Next.js shell, sign-in page, authenticated layout with the nine
   sections from PRD 6, and the typed API client.
4. Then phase 2, starting with People and General Notes `[ID-02, ID-08]`.

---

## Repository layout

```
apps/
  api/                 NestJS REST API and webhook receivers
  web/                 Next.js front end
  worker/              BullMQ job processors
packages/
  config/              Typed environment loading and production safety gate
  contracts/           Shared enums, Zod schemas, RBAC matrix, phone normalization
  db/                  Drizzle schema, migrations, RLS policies, seed, scripts
  security/            Password hashing, tokens, envelope encryption, TOTP
  connectors/          Adapter interfaces plus mock and live implementations
docs/
  HANDOFF.md           Resume point for the next session or agent
  decisions.md         Decision log with rationale
PRD.md  BRD.md         Requirements
ARCHITECTURE.md        System design and the rules that must not be broken
```
