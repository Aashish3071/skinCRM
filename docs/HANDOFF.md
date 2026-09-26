# Handoff — resume point

**Updated:** 2026-09-26
**Phase:** 4 of 9 (Messaging core) — engine, worker, canvas and SMTP done; template editor, delivery-log screen and unsubscribe page outstanding
**Overall:** ~62% of the build

Read [README.md](../README.md) to run it and [ARCHITECTURE.md](../ARCHITECTURE.md)
for the rules that must not be broken. This file says only what to do next.

---

## Get to a working state

```bash
cd /path/to/SkinCRM
pnpm install
cp .env.example .env          # skip if .env already exists
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm typecheck                # 5 packages, clean
pnpm lint                     # clean
pnpm test                     # expect 256 passing
```

If those 256 tests pass, the foundation is intact and you can build on it.

To run everything (the API also runs the background worker when
`WORKER_IN_API=true`, the development default):

```bash
pnpm dev
```

**Stop the dev API before `pnpm test`.** Its in-process worker claims the
automation runs the tests create and the automation tests then fail.

```bash
curl -s -c /tmp/c.txt -X POST http://localhost:4000/auth/login -H 'content-type: application/json' -d '{"email":"admin@sunshine-skin.test","password":"ChangeMe-Dev-2026!"}'
```

---

## What is finished and verified

### Packages

- **`config`** — environment parsed and validated once, with a production gate
  that refuses dev placeholders, a local crypto provider, or a missing
  `DATABASE_APP_URL`.
- **`contracts`** — domain enums (the source of truth for the Postgres enums),
  the RBAC capability matrix with per-role field masking, phone/email
  normalization and masking, and the Zod schemas for auth, people and leads.
- **`security`** — Argon2id with transparent rehash and timing-equalized failure,
  SHA-256 opaque token handling, per-clinic AES-256-GCM envelope encryption with
  the clinic id as AAD, TOTP with replay rejection, recovery codes, the outbound
  idempotency-key builder, and stateless signed unsubscribe tokens.
  **24 unit tests.**
- **`connectors`** — adapter interfaces plus email and WhatsApp mocks. A
  connector set to `live` with no implementation throws at resolution rather
  than falling back to a mock.
- **`db`** — 26 tables across six migrations. RLS policies in `sql/900_rls.sql`,
  re-applied on every migrate. **14 isolation tests**, including one that
  discovers every `clinic_id` table from the catalog and fails if any is
  unprotected. Idempotent seed: two clinics, 11 stages each, 7 users.

### `apps/api` (Fastify) — 213 integration tests

- `src/route.ts` — the route contract. Correlation id, request context, Zod
  validation, session resolution, capability check, tenant transaction and
  request logging in one place. **Read ARCHITECTURE.md section 8a before adding
  an endpoint.**
- `src/context.ts` — `AsyncLocalStorage`. `getTx()` is the only way to reach the
  database inside a request.
- `src/errors.ts` — one envelope; `AppError.extra` carries payload a client needs
  to act on a failure (the duplicate candidates on a 409).
- `src/serialize.ts` — per-role field masking, the third layer after capability
  and RLS.
- `src/audit.ts`, `src/logger.ts` — append-only audit written inside the caller's
  transaction, with a redaction list applied to both logs and change summaries.
- `src/auth/`, `src/users/`, `src/people/`, `src/leads/`, `src/intake/`, `src/calendar/`,
  `src/messaging/`.
- `src/messaging/send-gate.ts` — **the only place** that decides whether a
  message may go out. Read it before touching any send path.
- `src/calendar/timezone.ts` — clinic-local conversions through the IANA database.
  Use these rather than hand-rolling an offset.

Routes live today:

| Area | Routes |
|---|---|
| Health | `GET /health`, `GET /health/ready` |
| Auth | `POST /auth/login` (MFA, recovery code, clinic selection, lockout), `/auth/logout`, `GET /auth/session`, `/auth/password-reset` + `/confirm`, `/auth/change-password`, `/auth/mfa/enroll|confirm|disable`, `/auth/accept-invite` |
| Users | `GET|POST /users`, `PATCH|DELETE /users/:id`, `GET /branches` |
| People | `GET|POST /people`, `POST /people/check-duplicates`, `GET|PATCH /people/:id`, `GET /people/duplicates`, `POST /people/:id/merge`, `GET /people/merges`, `POST /people/merges/:id/revert`, `GET /people/:id/leads` |
| Notes | `GET|POST /people/:id/notes`, `PATCH|DELETE /notes/:noteId` |
| Consent | `GET|POST /people/:id/consent` |
| Leads | `GET /pipeline/stages`, `GET|POST /leads`, `GET|PATCH /leads/:id`, `POST /leads/:id/stage`, `POST /leads/:id/assign`, `GET /leads/:id/timeline`, `POST /leads/:id/contact-attempts`, `POST /leads/:id/notes` |
| Tasks | `GET|POST /tasks`, `POST /tasks/:id/complete`, `POST /tasks/:id/snooze`, `GET /leads/:id/tasks` |
| Routing | `GET|POST /assignment-rules`, `PATCH|DELETE /assignment-rules/:id`, `POST /assignment-rules/preview` |
| Intake | `POST /imports/csv/preview`, `POST /imports/csv`, `POST /settings/website-form-key`, `POST /webhooks/website` (public) |
| Messaging | `GET /templates/variables`, `GET|POST /templates`, `PATCH /templates/:id`, `POST /templates/:id/preview`, `GET|POST /messages`, `POST /messages/opt-out`, `GET /suppressions`, `GET /integrations/messaging/health` |
| Calendar | `GET|POST /consultation-types`, `PATCH /consultation-types/:id`, `GET|PUT /working-hours`, `GET|POST /appointments`, `GET /appointments/:id`, `POST /appointments/:id/reschedule|cancel|status`, `GET /availability` |

### `apps/web` (Next.js)

Sign-in with all three login branches, authenticated shell with capability-driven
navigation, Home wired to live counts, Leads list and Kanban, lead detail with
timeline and tasks, People search and profile with General Notes, duplicate
review and merge, and Settings → Staff. Inbox, Calendar, Automations and Reports
still render honest `NotBuiltYet` panels naming their phase.

The browser never calls the API directly: reads go through server components and
writes through Server Actions, both forwarding the session cookie.

Nothing is half-finished. No failing tests, no temporary workarounds beyond the
`TODO(phase 4)` markers listed under known gaps.

---

## Do this next, in order

The automation engine, worker, canvas builder, SMTP connector and the UI
simplification landed on 2026-09-26 — see README "Done in phase 4, second
slice" and ARCHITECTURE §6a. The pipeline is now six stages (D-57).

### 1. Templates tab `[MSG-02]`

API is complete (`GET/POST/PATCH /templates`, `POST /templates/:id/preview`,
`GET /templates/variables`). Add a Templates tab under `/automations` with an
editor, the operational/promotional choice, variable insert chips (reuse
`friendlyVariable` and the insert logic in
`apps/web/src/app/(app)/automations/builder/inspector.tsx`) and a live preview.
The canvas already offers saved templates in its send steps once any exist.

### 2. Delivery log tab `[MSG-07]`

`GET /messages` exists. Show each message with state and, for suppressed ones,
the reason in plain English (`SUPPRESSION_REASON_LABELS` in
`packages/contracts/src/messaging.ts`). Link each row to its lead and, when
`ruleId` is set, to the automation.

### 3. Public unsubscribe page

`/unsubscribe/[token]` outside the `(app)` group, calling a new public API route
that verifies the token (`verifyUnsubscribeToken`) and calls `recordOptOut`
inside `runAsSystem(clinicId, …)`. One-click, no login, idempotent. Also send
`unsubscribeUrl` on promotional email so the SMTP connector sets
`List-Unsubscribe` headers.

### 4. Email connection test `[MSG-01]`

A Settings → Email screen calling `connectors.email.verify()`; per-clinic SMTP
credentials stored encrypted with `encryptForClinic` rather than the global env.

### 5. Phase 5 — WhatsApp shared inbox `[WA-01…09]`

Conversation model, assignment/locking, internal notes, mock connector first.
Inbound messages must be written to `messages` with `direction = 'inbound'` —
that is what the automation "They reply" stop condition and the send gate's
24-hour window both read.

---

## Traps to avoid

1. **A new tenant table not listed in `packages/db/sql/900_rls.sql` has no RLS
   policy.** It would work perfectly in development and leak across clinics in
   production. The RLS suite now catches this automatically — it discovers every
   table with a `clinic_id` from the catalog — but the fix is still yours: add
   the name to the `tenant_tables` array and re-run `pnpm db:migrate`.
2. **Do not add `.js` extensions to relative imports.** Decision D-08.
3. **Do not call `getDb()` or `getOwnerDb()` from request-handling code.** Use
   `getTx()`. For genuinely cross-tenant work use
   `withoutTenantScope(reason, fn)` — there are only three legitimate callers
   today (decision D-28).
4. **Register routes through `registerRoute`,** never `app.route` directly, or
   you lose tenancy, authorization and validation at once.
5. **Never hand-edit `packages/db/drizzle/*.sql`.** Edit the schema, then
   `pnpm db:generate`.
6. **Leave the safety switches off.** `OUTBOUND_SENDING_ENABLED` and
   `CONVERSION_FEEDBACK_ENABLED` stay `false`; mock connectors are how the app is
   demoed.
7. **Do not delete the Northside Dermatology seed clinic.** It is the isolation
   control tenant, and tests assert against it.
8. **Adding an enum value** means editing `packages/contracts/src/enums.ts` and
   running `pnpm db:generate` — the Postgres enum is derived from it.
9. **Tests share the seeded database.** Each suite tags the rows it creates and
   deletes them in `beforeEach`/`afterAll` (see the `TAG` constant in
   `people.test.ts` and `leads.test.ts`). Keep that habit, or run `pnpm db:reset`
   if a suite leaves things dirty.
10. **Never use `z.coerce.boolean()` on a query parameter.** `Boolean("false")`
   is `true`, so `?includeClosed=false` silently means the opposite. Use
   `queryBoolean()` from `@skincrm/contracts` (decision D-36).
11. **Milestone timestamps are write-once.** Do not re-stamp `qualifiedAt` and
   friends when a lead re-enters a stage; conversion feedback depends on the
   original event time (decision D-31).
12. **Do not replace the appointment exclusion constraint with an application
   check.** It is the only thing that makes double-booking impossible under
   concurrency (decision D-40). If you add a column to the reserved range, keep
   the buffer inside it.
13. **`next build` and `next dev` share `.next`.** Running the build while the
   dev server is up leaves it serving a broken tree; stop dev first, then
   `rm -rf apps/web/.next` if it happens.
14. **Every send must go through `evaluateSend`.** Do not add a second send
   path that calls a connector directly — the gate is the only thing enforcing
   consent, suppression, the service window and the frequency cap (D-47).
15. **Never write a message row after calling the provider.** The row claims the
   idempotency key; writing it afterwards risks a silent double send (D-49).
16. **In tests, never pick a clinic with `select().from(clinics).limit(1)`.** It
   can return the isolation-control tenant, and fixture rows then land where the
   code under test will never see them. Resolve the clinic from the person.
17. **`getEnv()` caches.** Changing an environment variable inside a test has no
   effect until `resetEnvCache()` is called.
18. **Every new path that creates a lead or changes an appointment must call
   `emitAutomationEvent()`** inside its transaction, or automations silently
   never fire for it. `POST /leads` originally missed this — the tests caught it.
19. **Background code must use `runAsSystem(clinicId, fn)`**, never
   `withoutTenantScope` for tenant work. The worker only uses the owner
   connection to *claim* run ids across clinics.
20. **Don't reintroduce retired stages** (`qualified`, `nurture`, …) in seeds or
   UI; `changeStage` refuses them and `930_simplify_pipeline.sql` deactivates
   them on every migrate.
21. **`next build` beside `next dev`:** use `NEXT_DIST_DIR=.next-build npx next build`
   in `apps/web` so the running dev server's `.next` is not clobbered.

---

## Known gaps and deferred items

| Item | Where | When |
|---|---|---|
| `disableRequestLogging` is deprecated in Fastify 5 | `apps/api/src/app.ts` | Swap for a `LogController` instance when upgrading to Fastify 6 |
| No per-IP cap on the login route beyond 30/5min | `apps/api/src/auth/routes.ts` | Phase 9 hardening: consider a Redis-backed sliding window |
| Automations run once per lead per rule (dedupe key `lead:<id>`), so a "stage changed" rule does not re-fire if a lead re-enters that stage | `apps/api/src/automations/engine.ts` | Revisit if clinics ask for it |
| The "Qualified" feedback milestone is unreachable after D-57 | `packages/contracts/src/enums.ts` | Phase 8, if Qualified-based optimisation is wanted |
| Dead-letter/replay view for failed automation runs | runs page shows `Failed` + reason only | Phase 9 |
| Inbox and Reports are hidden from the nav until built | `apps/web/src/components/nav.tsx` | Phases 5 and 6 |
| `people.branchId` is stored but nothing filters on it yet | `apps/api/src/people/routes.ts` | With branch permissions |
| Client self-service booking link `[CAL-06]` and external calendar sync `[CAL-07]` | — | P1, after MVP |

---

## Open questions for the client

None block the current work; defaults are in place. Carry these into the pilot:

- Clinic specialty and advertised services → generic consultation types for now.
- Objective criteria for a **Qualified** lead → the stage was retired at the client's
  request (D-57); confirm whether ad optimisation on Qualified is still wanted.
- Email and calendar provider → mock adapters until chosen.
- Existing WhatsApp Business number eligibility for the coexistence path → must
  be validated in a pilot before any cutover. Do not promise history backfill.
- HIPAA covered-entity status and vendor BAAs → blocks real data and live sends.
- Hosting and data region → currently cloud-agnostic Docker; AWS is the
  recommended path because it signs BAAs.
