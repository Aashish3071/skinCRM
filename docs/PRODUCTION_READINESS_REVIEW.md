# SkinCRM production readiness review

## Status update — 2026-09-29

| Finding | Status |
|---|---|
| P0 KMS setting does not use KMS | ⚠️ Mitigated: `CRYPTO_PROVIDER=aws-kms` is now refused at boot, so nothing claims KMS; the key is a strong secret from a secret manager (D-75). Real KMS wrapping is still open — decide per client (HIPAA covered entities may ask). |
| P0 Production compose could run in development mode | ✅ Fixed — `NODE_ENV: production` pinned on migrate/api/worker/web (D-85); gate covered by `config.test.ts` |
| P1 Backup path mismatches | ✅ Fixed — no `eval`, URL-decoding, container auto-detection (D-86); restore drill passed locally. Repeat on the server |
| P1 Alert marked delivered after email failure | ✅ Fixed — heartbeat only after a confirmed send; `monitor-alerts.test.ts` |
| P1 Readiness 200 while degraded | ✅ Fixed — 503; `auth.test.ts` health tests |
| P1 Conversion feedback missing | ✅ Built on mocks (D-79, D-80); needs the real accounts |
| Reporting hidden | ✅ Back in the nav (D-72) |
| First clinic/admin needed hand-written SQL | ✅ `pnpm db:create-clinic` (D-84) |
| Browser-level coverage | ✅ Playwright happy path in CI; more flows welcome |
| Still open | Real-account pilot (Meta, Google, WhatsApp coexistence, SMTP/SPF/DKIM), UAT pilot column, BAAs, KMS, billing/self-serve signup, legal pages, manual screen-reader pass |

The original review follows unchanged.


Reviewed 2026-09-27 against the current working tree, including uncommitted deployment and operations changes. This is a code and configuration review, not a live production or provider-account test.

## Verdict

The core CRM is substantial and builds cleanly, but it is **not ready for a client production launch**. The highest risk is the gap between the production configuration's KMS promise and the encryption implementation. The new deployment and backup paths also need end-to-end validation and fixes. Conversion feedback is still unbuilt even though the PRD marks it P0.

## Confirmed findings, in priority order

### P0 — KMS setting does not use KMS

- `packages/config/src/env.ts:143-145` refuses `CRYPTO_PROVIDER=local` in production and requires `KMS_KEY_ID` for `aws-kms`.
- `packages/security/src/encryption.ts:38-47` always derives the encryption key from `CRYPTO_MASTER_KEY`; the module never reads `CRYPTO_PROVIDER` or `KMS_KEY_ID`.
- Impact: a deployment can pass its production safety gate while still encrypting provider tokens and raw payloads with a local environment secret. Rotation and KMS-backed key protection are not implemented. Implement and test an actual KMS-backed key flow, including migration/rotation of existing ciphertext, or change the documented safety requirement before launch.

### P0 — Production Compose can run with development mode

- `.env.example:7` sets `NODE_ENV=development` and instructs users to copy it to `.env`.
- `deploy/docker-compose.prod.yml:28,39,54,63` loads that file into the production services. The API and worker image's `NODE_ENV=production` default is overridden by the container environment.
- Impact: if the copied value is left in place, `assertProductionSafety` is never called. Add an explicit `NODE_ENV: production` override to each production service that runs application code, and validate the final container environment.

### P1 — Backup path is not proven and has concrete setup mismatches

- `scripts/lib/pg.sh:16,29` defaults to a container named `skincrm-postgres`; `deploy/docker-compose.prod.yml:9-13` declares project `skincrm` and service `postgres`, with no fixed container name. The fallback `docker exec` path will not find the intended container unless `PG_CONTAINER` is set manually.
- `scripts/lib/pg.sh:12` uses `eval` to load values from `.env`, so passwords containing shell characters may be reinterpreted. `scripts/lib/pg.sh:18-21` also parses database URLs with a regex that does not handle percent-encoded credentials.
- `scripts/restore.sh:19-21` and `scripts/verify-backup.sh` were syntax-checked but not exercised against a database. Replace the container lookup with `docker compose exec` or a configured service identifier, parse secrets safely, and run a restore drill before relying on backups.

### P1 — Alerts can be marked delivered after an email failure

- `apps/api/src/messaging/system-email.ts` returns `false` when sending fails.
- `apps/api/src/ops/monitor.ts:119-120` ignores that result and records an alert heartbeat anyway. A failed alert email is therefore suppressed for the next hour.
- Record the alert heartbeat only after a confirmed send, then test failure and retry behavior.

### P1 — Readiness reports HTTP 200 while degraded

- `apps/api/src/app.ts:113-124` returns `{status: "degraded"}` for a stale worker but keeps the route's successful HTTP status. HTTP-based readiness probes will still treat it as healthy. Return a non-2xx status when the worker or database readiness condition fails; keep `/health` as liveness.

### P1 — P0 product scope is still missing

- `README.md:142` states conversion feedback is not started. A repository search found only configuration, types, and comments, not a feedback outbox, destination mapping, provider delivery adapters, or diagnostics. The PRD lists `FB-01` through `FB-10` and `INT-09` as P0 (`PRD.md:153,167-176`).
- Reporting exists but is hidden at the client's request (`README.md:140`). This is a product decision to confirm for each client because the PRD lists reporting and export as P0.

## Launch work remaining

1. Fix the P0 and P1 findings above; add focused regression tests for the production environment gate, KMS provider selection, alert failure handling, readiness status, and backup/restore flow.
2. Build conversion feedback if it remains in the saleable product's agreed scope: destination maps, eligibility checks, exact payload preview, durable idempotent outbox, retries, diagnostics, and pause/revoke controls. Keep outbound sending disabled until a specific client's destination and payload are approved.
3. Test the full production image and Compose stack on a clean host: migrations, app-role RLS, web/API/worker startup, public webhook routing, HTTPS, health checks, and controlled shutdown. The Compose file parses, but these paths were not run in this review.
4. Finish a real backup schedule, off-host storage, restore verification, and an agreed recovery point/time. `docs/DEPLOYMENT.md`, referenced by the production Compose file, does not exist yet.
5. Pilot real SMTP, Meta, Google, and WhatsApp accounts with the client; verify their existing WhatsApp number's supported onboarding path, sender domain, consent copy, data region, and vendor/privacy agreements.
6. Run and record the 15 pilot UAT scenarios in `PRD.md:265-281`, including roles, duplicate webhooks, outage/replay, booking conflicts, opt-outs, and exports. Add browser-level coverage for the most valuable workflows; the current web test suite contains five calendar-view tests.
7. Establish measurable launch gates from `PRD.md:252-263`: lead processing freshness, user response time, availability, accessibility, backup recovery, and alert delivery. Exercise them under a representative pilot load.

## Checks run

- `pnpm typecheck`: passed across all seven packages.
- `pnpm lint`: passed.
- `pnpm build`: passed for API and web. The web build warned that the Next.js ESLint plugin was not detected.
- `docker compose -f deploy/docker-compose.prod.yml config --services`: parsed successfully with dummy required values.
- `bash -n` on all backup/restore scripts: passed.
- `pnpm test`: incomplete. The database suite could not connect to local PostgreSQL port 5433 because the sandbox denied the connection (`EPERM`). This does not establish a failing application test. The security and web unit suites passed before the aggregate run stopped; the API result was not established in this run.

No existing source files were changed during this review.
