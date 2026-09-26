# Handoff — resume point

**Updated:** 2026-09-26
**Phase:** 2 of 9 (Core CRM) — People and Leads APIs complete; intake and UI outstanding
**Overall:** ~30% of the build

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
pnpm test                     # expect 127 passing
```

If those 127 tests pass, the foundation is intact and you can build on it.

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
- **`db`** — 19 tables across two migrations. RLS policies in `sql/900_rls.sql`,
  re-applied on every migrate. **14 isolation tests**, including one that
  discovers every `clinic_id` table from the catalog and fails if any is
  unprotected. Idempotent seed: two clinics, 11 stages each, 7 users.

### `apps/api` (Fastify) — 89 integration tests

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
- `src/auth/`, `src/users/`, `src/people/`, `src/leads/`.

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

### `apps/web` (Next.js)

Sign-in with all three login branches, authenticated shell with capability-driven
navigation, Settings → Staff wired to the users API, and honest `NotBuiltYet`
panels for sections still to come. The browser never calls the API directly:
reads go through server components and writes through Server Actions, both
forwarding the session cookie.

Nothing is half-finished. No failing tests, no temporary workarounds beyond the
`TODO(phase 4)` markers listed under known gaps.

---

## Do this next, in order

### 1. Assignment rules `[LEAD-03]`

Manual assignment and the unassigned queue work. The rule engine does not exist.

- New table `assignment_rules`: clinic, priority (integer, deterministic order),
  match conditions (source, service interest, branch), target user or round-robin
  pool, active flag. **Add it to `tenant_tables` in
  `packages/db/sql/900_rls.sql`.**
- Evaluate on lead creation, in priority order, first match wins; no match leaves
  `ownerUserId` null so it lands in the queue.
- Admin can reassign — that already works via `POST /leads/:id/assign`.

### 2. Remaining intake `[ID-04, ID-05, ID-07]`

- **CSV import**: upload, preview with field mapping, per-row validation,
  reporting invalid rows without aborting the batch. Re-importing the same file
  must not duplicate: write a `source_submissions` row per CSV line with
  `platform: "csv"` and a deterministic `external_id` (file fingerprint + row
  index), and let the unique index do the work.
- **Website lead endpoint**: public `POST /webhooks/website`, rate limited and
  abuse controlled, recording consent text and version plus UTM attribution,
  returning a clear success or failure.
- Both flow through `source_submissions` → person match → lead, which is the
  same pipeline the ad adapters will use in phase 7. Build the shared normalize/
  match/create path now rather than duplicating it later.

### 3. Phase 2 UI

Leads list and Kanban with the filters the API already supports, lead detail with
the timeline, tasks and the General Notes panel, People search and profile, the
duplicate review and merge screen, and the Home work queue wired to real counts
(the tiles currently show an em dash on purpose).

### 4. Phase 3 — Calendar `[CAL-01…05]`

Consultation types with duration and buffer, working hours, day/week calendar,
and booking that **cannot** double-book. Use a Postgres exclusion constraint on
`(staff_id, tstzrange(start, end))` — `btree_gist` is already installed — rather
than a read-then-write check, which races.

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
| Assignment rules `[LEAD-03]` — manual assignment works, no rule engine | `apps/api/src/leads/` | Next task |
| CSV import `[ID-04]` and website endpoint `[ID-05]` | — | Next task |
| Phase 2 UI: leads, people, timeline screens | `apps/web` | Next task |
| `people.branchId` is stored but nothing filters on it yet | `apps/api/src/people/routes.ts` | Phase 3, with branch permissions |

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
