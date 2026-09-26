# Handoff — resume point

**Updated:** 2026-09-26
**Phase:** 3 of 9 (Calendar) — API complete; calendar UI and reminders outstanding
**Overall:** ~45% of the build

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
pnpm test                     # expect 183 passing
```

If those 183 tests pass, the foundation is intact and you can build on it.

To drive the API by hand:

```bash
pnpm --filter @skincrm/api dev
```

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
  idempotency-key builder. **24 unit tests.**
- **`db`** — 23 tables across five migrations. RLS policies in `sql/900_rls.sql`,
  re-applied on every migrate. **14 isolation tests**, including one that
  discovers every `clinic_id` table from the catalog and fails if any is
  unprotected. Idempotent seed: two clinics, 11 stages each, 7 users.

### `apps/api` (Fastify) — 145 integration tests

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
- `src/auth/`, `src/users/`, `src/people/`, `src/leads/`, `src/intake/`, `src/calendar/`.
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

### 1. Calendar UI `[CAL-01]`

The API is complete and tested; there is no calendar screen yet. `/calendar`
currently renders a `NotBuiltYet` panel.

- Day and week views by staff and branch, rendered in the clinic timezone. Use
  `GET /appointments?from=YYYY-MM-DD&to=YYYY-MM-DD`, which returns the timezone
  alongside the rows.
- A booking dialog driven by `GET /availability?date=&staffUserId=&consultationTypeId=`,
  which already marks each slot `booked`, `outside_hours` or `in_past`.
- Reschedule and cancel, both of which require a reason the UI must capture.
- Settings screens for consultation types and working hours (`PUT /working-hours`
  replaces the whole set for one person, deliberately).
- A 409 from booking means the slot went while the user was looking at it. Show
  the message and refresh availability rather than retrying.

### 2. Phase 4 — messaging core `[MSG-01…07]`

This is the largest remaining phase and it unblocks several loose ends.

- `packages/connectors`: adapter interfaces plus **mock** implementations for
  email and WhatsApp. The app must stay fully demoable with no credentials.
- `apps/worker`: the first BullMQ processors. Create the app here.
- Templates with an operational/promotional classification, approved variables,
  preview, and stored rendered content with its template version.
- The automation engine: triggers, conditions, delays, quiet hours, enrollment,
  and stop conditions (reply, booking, conversion, opt-out, closure).
- **Send safety is the hard part.** Re-read consent, lead stage, appointment
  state, rule status, frequency cap and the WhatsApp service window
  *immediately before sending*, never at schedule time. The idempotency key
  builder already exists: `buildIdempotencyKey` in `@skincrm/security`. Anything
  blocked is recorded with a `suppression_reason`, never dropped silently.
  ARCHITECTURE.md section 6 is the checklist.
- Delivery log covering scheduled, queued, sent, delivered, bounced, failed,
  canceled and suppressed.

Phase 4 also closes three things already marked TODO:
- invite and password-reset emails (currently printed to the API console),
- appointment confirmation and reminder jobs `[CAL-05]`, including cancelling
  pending reminders when an appointment is rescheduled or cancelled — there is a
  `TODO(phase 4)` at the reschedule handler in `apps/api/src/calendar/routes.ts`,
- `pruneExpiredSessions()`, which is written but never scheduled.

### 3. Phase 5 — WhatsApp shared inbox `[WA-01…09]`

Conversation model, assignment so two staff cannot unknowingly reply to the same
thread, the 24-hour service window, and approved templates. Mock connector
first; the real Cloud API and the coexistence pilot belong to phase 7.

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

---

## Known gaps and deferred items

| Item | Where | When |
|---|---|---|
| Password-reset and invite emails are logged to the console, not sent | `TODO(phase 4)` in `apps/api/src/auth/routes.ts` and `users/routes.ts` | Phase 4, with the email connector |
| `pruneExpiredSessions()` is written but nothing calls it | `apps/api/src/auth/sessions.ts` | Phase 4, as a scheduled worker job |
| No lint setup yet (`pnpm lint` is a no-op) | root | Add ESLint with the phase 2 work |
| `disableRequestLogging` is deprecated in Fastify 5 | `apps/api/src/app.ts` | Swap for a `LogController` instance when upgrading to Fastify 6 |
| No per-IP cap on the login route beyond 30/5min | `apps/api/src/auth/routes.ts` | Phase 9 hardening: consider a Redis-backed sliding window |
| `apps/worker` does not exist yet | — | Phase 4, when the first job appears |
| Calendar UI — the API is complete, there is no screen | `apps/web/src/app/(app)/calendar` | Next task |
| Appointment reminders `[CAL-05]` — `TODO(phase 4)` at the reschedule handler | `apps/api/src/calendar/routes.ts` | Phase 4 |
| `people.branchId` is stored but nothing filters on it yet | `apps/api/src/people/routes.ts` | With branch permissions |
| Client self-service booking link `[CAL-06]` and external calendar sync `[CAL-07]` | — | P1, after MVP |

---

## Open questions for the client

None block the current work; defaults are in place. Carry these into the pilot:

- Clinic specialty and advertised services → generic consultation types for now.
- Objective criteria for a **Qualified** lead → staff-confirmed criteria per PRD 4.5a.
- Email and calendar provider → mock adapters until chosen.
- Existing WhatsApp Business number eligibility for the coexistence path → must
  be validated in a pilot before any cutover. Do not promise history backfill.
- HIPAA covered-entity status and vendor BAAs → blocks real data and live sends.
- Hosting and data region → currently cloud-agnostic Docker; AWS is the
  recommended path because it signs BAAs.
