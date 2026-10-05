# Handoff — resume point

**Updated:** 2026-10-01
**Phase:** Core CRM implemented; launch hardening and customer controls added. Live-provider acceptance and email lifecycle integration remain open.
**Overall:** Do not describe this as production-certified. Use the outstanding gates below when planning the client pilot.

Read [README.md](../README.md) to run it and [ARCHITECTURE.md](../ARCHITECTURE.md)
for the rules that must not be broken. This file says only what to do next.

---

## Latest — 2026-10-05 (second half)

Built and pushed: legal pages, saved lead views + bulk assign, online booking
+ patient manage links (D-92), AWS KMS root key + rotation (D-93), two-way
Google/Outlook calendar sync (D-94), Advertising: spend, campaign controls,
audiences, past-lead and WhatsApp-app history import (D-95), Postmark replies
and bounces (D-96). Migrations 0017–0022 (apply with `pnpm db:migrate`).
Verified on a fresh DB: 430 unit/API tests and 4 browser tests (run e2e
against a production build — `next start -p 3200` — the dev server compiles
too slowly). Docs for D-96 setup in DEPLOYMENT.md are still minimal: add a
Postmark section (server token, inbound address, webhooks with basic auth,
broadcast stream). Real-provider pilots for all new integrations are pending.

## Verification — 2026-10-05

Finished the D-90/D-91 work: a WhatsApp **STOP** from a known patient opened a
new sales lead (the open-lead lookup was skipped for opt-outs, then a lead was
created). It now attaches to any open lead and never creates one
(`apps/api/src/inbox/service.ts`). Verified on a fresh migrated + seeded scratch
database: typecheck, lint, **400 tests** (342 API, 24 security, 15 connectors,
14 RLS, 5 web) and **all 4 browser tests** (front desk, channel sync, branches /
pipeline / CSV import, WhatsApp template import; run with
`E2E_BROWSER_CHANNEL=chrome` when Playwright's bundled browser is not installed).
The normal dev database was migrated to 0016 after a `pg_dump` backup.

## Latest implementation — launch hardening (D-91)

The six findings from the October 1 QA pass have implementations and regression coverage:

- Patient merges move appointments, messages, submissions, automation enrollments,
  suppression records and delivery receipts. Duplicate inbox threads are combined;
  undo restores original history while keeping later messages with the survivor.
  Incoming phone/email aliases follow the surviving patient.
- WhatsApp template catalogue loading, CRM-field mapping/import and approval refresh
  are available under Automations → Message templates. Live sends verify provider
  status and matching content. Template authoring/submission happens in WhatsApp
  Manager. Supported imports use positional text body parameters; media, buttons,
  authentication and named parameters are explicitly unsupported.
- A separate, tenant-scoped database pool commits delivery receipts before sending.
  Provider acknowledgement can be reused after caller rollback. Uncertain sends are
  never automatically resent. The worker restores missing message history; admins
  resolve uncertain outcomes in Sent messages after checking provider evidence.
  This is **not** an exactly-once guarantee from SMTP or WhatsApp.
- Inbox histories use a stable date/ID cursor and a Load older messages button.
  Inbox and patient lists also paginate. Staff reply retries reuse a request UUID.
- Inbox simulation is disabled in production and in live WhatsApp mode. Messaging
  health uses the actual per-clinic WhatsApp connector.
- CI explicitly enables conversion tests with all providers mocked. Browser tests
  run serially because they share clinic settings. The front-desk fixture now uses
  a valid patient name under the existing validation rules.

Additional customer controls: branch create/edit/default/archive; pipeline label
and display-order editing; CSV upload/mapping/preview/confirmation; inquiry-note
edit/archive with audit entries; inbox tags searchable in the chat list. Pipeline
outcome categories stay fixed to preserve automation/reporting meaning.

### Database and rollout

Apply migrations `0014`–`0016` through `pnpm db:migrate` before deploying the API
or worker. They add delivery receipts, encrypted recovery content, inbox tags and
inquiry-note archive timestamps. The RLS script covers the new tenant table.
Receipt writes use up to ten extra application-role database connections per
API/worker process; include them in the deployment connection budget.

All development verification for this change uses a disposable database. The
normal development database and external ad/messaging accounts are not migration
or test targets. Existing in-progress integration changes were preserved.

### Still required before promising a fully live client rollout

1. Choose and implement the email provider's inbound replies, asynchronous delivery,
   bounce and complaint events. SMTP submission alone does not provide these.
   The user has been asked which provider should be supported.
2. Perform the real-account pilot in INTEGRATION_SYNC.md: app permissions,
   WhatsApp signup/template sending, lead receipt, conversion matching, revocation
   and reconnect recovery. Mock success cannot certify external account eligibility.
3. Apply migrations and repeat backup restore, alerts, capacity and customer UAT on
   the actual deployment. Accessibility/load results from September predate these
   new screens and must not be treated as verification of them.
4. Confirm the sold scope. Saved views, bulk assignment, self-service booking,
   external calendar sync, historic ad/chat backfill, ad spend and audience-list
   sync remain outside this implementation. Clinical records/billing remain outside
   the product's documented CRM scope.

## Latest implementation — channel sync (D-90)

See [INTEGRATION_SYNC.md](INTEGRATION_SYNC.md). Connected-asset selection,
independent Meta/WhatsApp feedback and tests, Google conversion-action ownership,
Data Manager permission and v25 Ads calls, asynchronous Google acceptance,
hourly Google-form linking, same-account reconnect key preservation, returning
WhatsApp ad attribution, latest-ad reports/CSV and retry/check controls are built.
Account/mapping changes revoke tests and prevent queued/rejected events from
being retargeted. Test-mode candidates remain tests after promotion.

New regression coverage: `packages/connectors/src/ad-sync.test.ts`,
`apps/api/src/__tests__/ad-sync.test.ts`, feedback promotion regression and
`apps/web/e2e/channel-sync.spec.ts`. API tests used a separate migrated/seeded
scratch database, with workers disabled. Turbo test tasks pass explicit database
URLs through and do not cache database-dependent test results. Use a disposable database for the new
browser test: it replaces the demo clinic's connections and conversion setup.
All three provider modes must be mock; set `E2E_BROWSER_CHANNEL=chrome` to use
an installed Chrome if the bundled Playwright browser is unavailable.

Verification: full workspace suite passed before the final WhatsApp reconnect
regression was added; the updated ad-sync/signup suites (19 tests), lint,
typecheck and the all-channel browser flow also passed. Expected total: 386
workspace tests. The production build passed and was repeated after UI changes.

Live Meta/Google/WhatsApp accounts have **not** been used to certify this build.
The setup, provider permissions, real webhook delivery and one real approved
conversion per enabled path are the next required launch checks. Historical
chat/lead imports, spend sync, campaign edits and patient-audience uploads are
outside the implemented scope.

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
pnpm test                     # expect 400 passing
```

If those tests pass, the foundation is intact and you can build on it.

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

### `apps/api` (Fastify) — 330 tests, including channel-sync regressions

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
review and merge, and Settings → Staff. Inbox, Calendar, Automations, Notes,
Activity, Reports and integration settings are implemented. Patient details
are edited at `/people/[id]/edit`. Notes and Activity share one filter panel
(`components/feed-filters.tsx`).

The browser never calls the API directly: reads go through server components and
writes through Server Actions, both forwarding the session cookie.

Browser test: `apps/web/e2e/front-desk.spec.ts` (`pnpm --filter @skincrm/web e2e`
with the app running; CI runs it against the production builds).

---

## Do this next, in order

Sixth session (2026-09-28/29): Reports unparked, staff Delete, patient edit,
Notes/Activity filter panel, a role-change hang fixed (D-82), launch blockers
from docs/PRODUCTION_READINESS_REVIEW.md fixed, `pnpm db:create-clinic`,
Playwright in CI. See the latest verification section above for current coverage and remaining launch gates.

Local `.env` has `CONVERSION_FEEDBACK_ENABLED=true` (mock connectors, nothing
leaves the machine). Both feedback destinations were left **Off**.

Seventh session (2026-09-29): Connect with Facebook / Google Ads (D-87) and an
error screen for an unreachable API. 341 tests + browser test passing.

Eighth session (2026-09-29): Connect WhatsApp with Embedded Signup incl.
coexistence (D-88), and contact-field validation across every form and the API
(D-89; rules in `packages/contracts/src/contact.ts`, inputs in
`apps/web/src/components/contact-inputs.tsx`). Live-provider acceptance remains required.

### 1. Pilot with the clinic's real accounts — docs/DEPLOYMENT.md
0. Create the Meta app (incl. WhatsApp + Embedded Signup configuration) and the
   Google OAuth client with Ads/Data Manager API access (DEPLOYMENT §4), then have the clinic
   press Connect with Facebook / Google Ads / WhatsApp. **Verify Google's
   lead-form webhook update and the WhatsApp coexistence onboarding against real
   accounts** before relying on them.
1. Server + `.env` (DEPLOYMENT §1–2), `docker compose … up -d --build`.
2. `pnpm db:create-clinic …` through the `migrate` service (DEPLOYMENT §3);
   send the admin their invite link.
3. SMTP with SPF/DKIM (DEPLOYMENT §4). For coexistence numbers, consider
   requesting Meta's contacts/history sync (not built; D-88).
4. Feedback: Settings → Ad platform feedback, checklist, **test event against
   the real account** (including WhatsApp's separate dataset and Google's
   asynchronous upload diagnostics), confirm in Events Manager / Google Ads, then Go live.
5. Backup cron + off-host copy, then `scripts/verify-backup.sh` on the server.
6. Walk the 15 scenarios in docs/UAT.md with the clinic; fill "Pilot result".

### 2. Before selling to more clinics
- KMS-wrapped master key if a client requires it (D-75).
- Billing / plans / self-serve signup (today: `pnpm db:create-clinic`).
- Privacy policy and terms pages in the app.
- More Playwright flows (inbox reply, export matches filters).

### 3. Smaller follow-ups
- Business-hours SLA (D-73); email copies of notifications if staff ask.
- Email connection-test screen (MSG-01).
- Manual screen-reader pass.

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
22. **Server actions must be `export async function`.** An arrow-function
   `export const x = () => …` in a `"use server"` file compiles in `tsc` but
   breaks the Next build ("Server Actions must be async functions").
23. **Grid children need `min-w-0`** or a long truncated line stretches the whole
   page on a phone (the automation builder did exactly this).
25. **Tests share the dev database.** Cleanups must delete only rows the test
   created (see `TEST_ACCOUNT_IDS` in `integrations.test.ts`). The Google key
   test replaces the clinic's Google connection — don't run it against a dev
   database with a real Google connection you care about.
26. **Literal U+FEFF in source fails lint** — write `"\uFEFF"`.
27. **Python string edits turn `"\n"` into real newlines** in TypeScript
   string literals. Write `"\\n"` in the Python source, or edit with a tool.
28. **`registerRoute` owns the status code.** Setting `reply.code()` inside a
   handler is overwritten; throw an `AppError`, or use a plain `app.get` (as
   `/health/alerts` does).
29. **Tests that depend on `OUTBOUND_SENDING_ENABLED` must set it** — a
   developer's local `.env` may have sending on.
31. **Never run `next build` into `.next` while `next dev` is running** — dev now
   uses `.next-dev` (next.config.ts) so this can't recur, but keep it that way.
32. **The ESLint config has no Next.js plugin** — don't write
   `eslint-disable @next/next/...` comments; the rule doesn't exist here.
30. **Port 3000 may be taken** on the dev machine (another Docker project);
   `web-3100` in `.claude/launch.json` runs the web app on 3100.
24. **Stop the dev API before `pnpm test`** — its in-process worker claims the
   automation runs the tests create.
21. **`next build` beside `next dev`:** use `NEXT_DIST_DIR=.next-build npx next build`
   in `apps/web` so the running dev server's `.next` is not clobbered. It rewrites
   `apps/web/tsconfig.json` and `next-env.d.ts` to point at `.next-build` —
   `git checkout` both afterwards.
33. **Never open a second transaction for a row the request already updated.**
   Inside a route, use `getTx()` (or a helper that joins it, like
   `revokeAllSessionsForUser`); `withTenant()` from inside a request that holds
   a row lock hangs forever (D-82).
34. **The Playwright test leaves an "E2E Walkin …" lead and an appointment three
   weeks out** in the database it runs against. Harmless on dev/CI; don't point
   it at a real clinic.

---

## Known gaps and deferred items

| Item | Where | When |
|---|---|---|
| `disableRequestLogging` is deprecated in Fastify 5 | `apps/api/src/app.ts` | Swap for a `LogController` instance when upgrading to Fastify 6 |
| No per-IP cap on the login route beyond 30/5min | `apps/api/src/auth/routes.ts` | Phase 9 hardening: consider a Redis-backed sliding window |
| Automations run once per lead per rule (dedupe key `lead:<id>`), so a "stage changed" rule does not re-fire if a lead re-enters that stage | `apps/api/src/automations/engine.ts` | Revisit if clinics ask for it |
| The "Qualified" feedback milestone is unreachable after D-57 | `packages/contracts/src/enums.ts` | Phase 8, if Qualified-based optimisation is wanted |
| Dead-letter/replay view for failed automation runs | runs page shows `Failed` + reason only | Phase 9 |
| `people.branchId` is stored (editable on the patient edit page) but nothing filters on it yet | `apps/api/src/people/routes.ts` | With branch permissions |
| Notes/Activity group-by works on the loaded page (up to 100 items), so a patient's group can continue after "Show more" | `apps/web/src/app/(app)/notes`, `activity` | If clinics need server-side grouping |
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
