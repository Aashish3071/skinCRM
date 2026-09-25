# Handoff — resume point

**Updated:** 2026-09-26
**Phase:** 1 of 9 (Foundation) — data layer complete, API not started
**Overall:** ~8% of the build

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
pnpm --filter @skincrm/db test   # expect 12 passing
```

If those 12 tests pass, the foundation is intact and you can build on it.

---

## What is finished and verified

- Monorepo: pnpm workspaces + Turborepo. Packages `config`, `contracts`, `db`,
  `security`.
- `docker-compose.yml`: Postgres 16 (port **5433**), Redis 7 (port **6380**),
  Mailpit (8025).
- `packages/config` — environment parsed and validated once, with a production
  gate that refuses dev placeholders, a local crypto provider, or a missing
  `DATABASE_APP_URL`.
- `packages/contracts` — all domain enums, the RBAC capability matrix with
  per-role field masking, phone/email normalization and masking, shared
  primitives, and auth request/response schemas.
- `packages/security` — Argon2id with transparent rehash and timing-equalized
  failure, SHA-256 opaque token handling, per-clinic AES-256-GCM envelope
  encryption with the clinic id as AAD, TOTP with replay rejection, recovery
  codes, and the outbound idempotency-key builder.
- `packages/db` — Drizzle schema for `clinics`, `branches`, `users`,
  `user_branches`, `sessions`, `auth_tokens`, `mfa_recovery_codes`,
  `pipeline_stages`, `audit_events`. Migration `drizzle/0000_tidy_network.sql`
  applied. RLS policies in `sql/900_rls.sql`, re-applied on every migrate.
- **12 RLS isolation tests passing.** This is the load-bearing test suite.
- Idempotent seed: two clinics (Sunshine Skin & Laser, plus Northside
  Dermatology as the isolation control), 11 pipeline stages each, 7 users.

Nothing is half-finished. There are no known failing tests and no temporary
workarounds in place.

---

## Do this next, in order

### 1. `apps/api` — NestJS skeleton

New app at `apps/api`. Run with `tsx watch` in dev; build with `tsup`.

Build these in this order, because each depends on the one before:

1. **Bootstrap** — Nest app, `API_PORT` from `@skincrm/config`, `helmet`, CORS
   restricted to `WEB_PORT`, cookie parsing, graceful shutdown that closes the
   DB pool via `closeAllConnections()`.
2. **Request context** — an `AsyncLocalStorage` store holding
   `{ correlationId, clinicId, userId, role, capabilities }`. Generate a
   correlation id per request and return it on every error.
3. **`ZodValidationPipe`** — validate body/query/params against a schema from
   `@skincrm/contracts`. On failure emit the shared error envelope from
   `apiErrorSchema` with `details` keyed by dotted path.
4. **Global exception filter** — map to `{ error: { code, message, details?,
   correlationId } }`. Never leak a stack trace or a driver message to the client.
5. **`SessionGuard`** — read the session cookie, hash it, look the session up,
   check `expiresAt`, `revokedAt` and that `sessions.session_epoch` still matches
   `users.session_epoch`. Refresh `lastSeenAt`. Populate the request context.
6. **`@RequireCapability(...)` decorator + `CapabilityGuard`** — resolve the
   caller's role through `capabilitiesForRole()` plus
   `users.grantedCapabilities`, and 403 when the capability is missing.
7. **`TenantInterceptor`** — wrap the handler in `withTenant(clinicId, ...,
   { actorUserId })` and expose the transaction handle to services. Every
   tenant-scoped query must run through it. Do not let a service reach for
   `getDb()` directly.
8. **`AuditService`** — one `record()` call writing to `audit_events` with actor,
   action, entity, redacted summary, ip, user agent and correlation id. It must
   **refuse** to store note bodies, message bodies or full contact details; write
   a unit test that proves a redaction helper strips them.

### 2. Auth routes `[ID-01]`

Contracts already exist in `packages/contracts/src/auth.ts` — use them, do not
invent new shapes.

| Route | Notes |
|---|---|
| `POST /auth/login` | Cross-tenant email lookup via `withoutTenantScope("login lookup by email", ...)`. Verify Argon2, rehash if `needsRehash`. If `mfaEnabledAt` is set and no `totpCode`, return `{ result: "mfa_required" }`. On unknown email call `burnPasswordVerification()` so timing does not reveal existence. Increment `failedLoginCount`, set `lockedUntil` after 5 failures. Audit `login_success` / `login_failure`. |
| `POST /auth/logout` | Set `revokedAt`. Clear the cookie. |
| `GET /auth/session` | Return `SessionUser`. |
| `POST /auth/password-reset` | Always return 200 regardless of whether the email exists. Create an `auth_tokens` row with purpose `password_reset`, 1-hour expiry. |
| `POST /auth/password-reset/confirm` | Single-use token, bump `session_epoch`. |
| `POST /auth/change-password` | Verify current password, bump `session_epoch`. |
| `POST /auth/mfa/enroll` | `createTotpEnrollment()`, store the secret encrypted with `encryptForClinic`. |
| `POST /auth/mfa/confirm` | Verify the code, set `mfaEnabledAt`, return hashed recovery codes once. |
| `POST /users` / `POST /auth/accept-invite` | Invite with `auth_tokens` purpose `invite`; accept sets name, password and `status: active`. |

Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when not development, 30-day
absolute expiry with a sliding idle timeout.

Add a rate limit on `/auth/login` and `/auth/password-reset`, keyed by IP and
email.

**Add a test that a marketing analyst receives 403 from any people or leads
route.** It will be the template for the permission suite in PRD UAT scenario 9.

### 3. `apps/web` — shell

Next.js App Router, `transpilePackages: ["@skincrm/contracts", "@skincrm/config"]`.
Sign-in page, authenticated layout with the nine sections from PRD section 6, a
typed fetch client that forwards the session cookie, and role-aware navigation
that hides what the user has no capability for. Keyboard-usable forms and labelled
controls from the start — WCAG 2.2 AA is a release gate, not a later pass.

### 4. Then phase 2

Start with `people` and `general_notes` `[ID-02, ID-08]`. Remember: a new tenant
table must be added to the `tenant_tables` array in
`packages/db/sql/900_rls.sql`, and the RLS suite extended to cover it.

---

## Traps to avoid

1. **A new tenant table not listed in `packages/db/sql/900_rls.sql` has no RLS
   policy.** It will work perfectly in development and leak across clinics in
   production. This is the easiest way to cause a breach here.
2. **Do not add `.js` extensions to relative imports.** See decision D-08.
3. **Do not call `getOwnerDb()` or `getDb()` from request-handling code.** Use the
   transaction from `TenantInterceptor`, or `withoutTenantScope(reason, fn)` when
   the work is genuinely cross-tenant.
4. **Never hand-edit `packages/db/drizzle/*.sql`.** Edit the schema, then
   `pnpm db:generate`.
5. **Leave the safety switches off.** `OUTBOUND_SENDING_ENABLED` and
   `CONVERSION_FEEDBACK_ENABLED` stay `false`; mock connectors are how the app is
   demoed.
6. **Do not delete the Northside Dermatology seed clinic.** It is the isolation
   control tenant.
7. **Adding an enum value** means editing `packages/contracts/src/enums.ts` and
   running `pnpm db:generate` — the Postgres enum is derived from it.

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
