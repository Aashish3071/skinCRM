# Handoff — resume point

**Updated:** 2026-09-26
**Phase:** 1 of 9 (Foundation) — data layer and API complete, web app not started
**Overall:** ~15% of the build

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
pnpm test                     # expect 70 passing
```

If those 70 tests pass, the foundation is intact and you can build on it.

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
- **`contracts`** — all domain enums (the source of truth for the Postgres
  enums), the RBAC capability matrix with per-role field masking, phone/email
  normalization and masking, shared primitives, auth request/response schemas.
- **`security`** — Argon2id with transparent rehash and timing-equalized failure,
  SHA-256 opaque token handling, per-clinic AES-256-GCM envelope encryption with
  the clinic id as AAD, TOTP with replay rejection, recovery codes, the outbound
  idempotency-key builder. **24 unit tests.**
- **`db`** — Drizzle schema for `clinics`, `branches`, `users`, `user_branches`,
  `sessions`, `auth_tokens`, `mfa_recovery_codes`, `pipeline_stages`,
  `audit_events`. Migration `drizzle/0000_tidy_network.sql` applied. RLS policies
  in `sql/900_rls.sql`, re-applied on every migrate. **12 isolation tests** — the
  load-bearing suite. Idempotent seed: two clinics, 11 stages each, 7 users.

### `apps/api` (Fastify)

- `src/route.ts` — the route contract. Correlation id, request context, Zod
  validation, session resolution, capability check, tenant transaction and
  request logging, all in one place. **Read ARCHITECTURE.md section 8a before
  adding an endpoint.**
- `src/context.ts` — `AsyncLocalStorage` request context. `getTx()` is the only
  way to reach the database inside a request.
- `src/errors.ts` — one error envelope, `{ error: { code, message, details?,
  correlationId } }`. No stack traces or driver messages reach the client.
- `src/logger.ts` — pino with a redaction list, plus `redactForAudit`.
- `src/audit.ts` — `recordAudit` writes inside the caller's transaction so an
  audited change and its audit row commit together. `diffSummary` records which
  fields changed without duplicating their values.
- `src/auth/` — sessions (opaque token stored as a hash, sliding idle expiry,
  epoch-based mass revocation) and the full auth service.
- `src/users/` — invite, list, update, archive, branch assignment.

Routes live today:

| Route | Notes |
|---|---|
| `GET /health`, `GET /health/ready` | Ready means the database answered |
| `POST /auth/login` | MFA challenge, recovery codes, clinic selection, lockout |
| `POST /auth/logout` | Public by design so a dead session can still clear its cookie |
| `GET /auth/session` | Returns `SessionUser` |
| `POST /auth/password-reset` + `/confirm` | Identical response whether or not the address exists |
| `POST /auth/change-password` | Revokes all sessions |
| `POST /auth/mfa/enroll` / `confirm` / `disable` | Admins cannot remove their own second factor |
| `POST /auth/accept-invite` | |
| `GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` | Admin only |
| `GET /branches` | |

**34 API integration tests**, covering the permission half of PRD UAT scenario 9,
cross-tenant attempts over real HTTP, lockout isolation, MFA end to end, and the
audit trail containing no personal data.

Nothing is half-finished. There are no known failing tests and no temporary
workarounds, apart from the two `TODO(phase 4)` markers noted below.

---

## Do this next, in order

### 1. `apps/web` — Next.js shell

New app at `apps/web`. `transpilePackages: ["@skincrm/contracts", "@skincrm/config"]`
because those packages ship TypeScript source.

1. **Typed API client** that forwards the session cookie (`credentials:
   "include"`), sends `x-correlation-id`, and narrows errors to the shared
   envelope. Import request/response types from `@skincrm/contracts` — do not
   restate shapes.
2. **Sign-in page** handling all three `LoginResponse` branches:
   `authenticated`, `mfa_required` (show a code field, accept a recovery code
   too), and `clinic_selection_required` (let the user pick, resubmit with
   `clinicId`).
3. **Authenticated layout** with the nine sections from PRD section 6: Home,
   Inbox, Leads, Lead detail, People, Calendar, Automations, Reports, Settings.
   Render navigation from `session.capabilities` so a marketing analyst never
   sees a People link. The API already enforces this; the UI should match it.
4. **Settings → Staff** against the existing `/users` routes, so phase 1 has a
   visible surface end to end.
5. Keyboard-usable forms and labelled controls from the start. WCAG 2.2 AA is a
   release gate (PRD 9), not a later pass.

### 2. Phase 2 — People and General Notes `[ID-02, ID-08]`

- `people`: `phone_e164` plus the original string, normalized email, preferred
  contact method, communication preferences. Use `normalizePhone` from
  `@skincrm/contracts` — do not write another parser.
- `general_notes`: belongs to the **person**, not the lead, so it stays visible
  across every lead for that person. Pinnable, archivable, fully audited.
  **Never** exported to an ad platform, inserted into an automated message, or
  logged.
- Duplicate detection on normalized phone and email, with a review queue and a
  reversible merge that preserves all submissions, notes, tasks and appointments.

### 3. Phase 2 — Leads, pipeline, tasks `[LEAD-01…06]`

`leads`, `lead_stage_events`, `activities`, `tasks`, assignment rules, the
unassigned queue. `pipeline_stages` already exists and is seeded.

### 4. Phase 2 — Intake `[ID-03…05]`

Walk-in form, CSV import with preview and field mapping, website lead endpoint.
`source_submissions` with its unique `(platform, external_id)` index is the
idempotency backbone for phase 7 — build it now, even though the ad adapters come
later.

---

## Traps to avoid

1. **A new tenant table not listed in `packages/db/sql/900_rls.sql` has no RLS
   policy.** It will work perfectly in development and leak across clinics in
   production. This is the easiest way to cause a breach here. Add the table
   name to the `tenant_tables` array and extend the isolation suite.
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
9. **Tests share the seeded database.** They reset the state they touch
   (`resetAuthState` in `apps/api/src/__tests__/helpers.ts`). Keep that habit, or
   run `pnpm db:reset` if a suite leaves things dirty.

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
