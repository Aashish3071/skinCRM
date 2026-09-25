# Decision log

Why each choice was made, so a later session does not undo a deliberate
decision. Newest at the bottom of each section.

Format: **decision** — rationale — what would change it.

---

## Product scope

**D-01. Build as multi-tenant SaaS from day one, not single-clinic.**
The product will be sold to the first client and other clinics. Retrofitting
tenancy is a rewrite of every query and every index. Chosen over single-tenant
deployments because per-clinic ops cost compounds with each customer.
*Would change if:* a customer demands physically separate infrastructure for a
compliance reason — in which case the same code deploys single-tenant, since
`clinic_id` is still present.

**D-02. Row-level security in Postgres, not application-level filtering alone.**
Application filtering fails open: forget one `where clinicId = ...` and you leak.
RLS fails closed: the same mistake returns an empty list. The app connects as a
non-owner role with `FORCE ROW LEVEL SECURITY` so even the owner path cannot
bypass policies. Both layers are kept — RLS is the backstop, not an excuse to
skip explicit filters.
*Would change if:* never, within this architecture.

**D-03. Requirement IDs from the PRD are used as the ticket and test vocabulary.**
`ID-01`, `LEAD-02`, `WA-06`, `FB-03` appear in code comments, status tables and
test names, so a reviewer can trace any line back to a requirement and the client
can check coverage.

---

## Stack

**D-04. TypeScript monorepo with pnpm + Turborepo.**
One language across web, API and worker means the Zod contract that validates a
request also types the form that produced it. Chosen over Python/FastAPI because
the shared-contract benefit outweighs Python's edge in reporting work, and the
reporting here is SQL aggregation rather than data science.

**D-05. ~~NestJS for the API.~~ Superseded by D-24.**

**D-06. Drizzle rather than Prisma.**
Raw SQL is needed for exclusion constraints, `set_config`, RLS policies and
window-function reporting. Drizzle stays close to SQL and lets the schema live in
TypeScript without an extra DSL and generated client.

**D-07. BullMQ on Redis for jobs.**
Durable retry, delayed jobs and dead-lettering are hard requirements (PRD 7), and
appointment reminders need reliable scheduling weeks out. Redis is already a
sensible dependency; a Postgres-only queue would need the same features rebuilt.

**D-08. Packages export TypeScript source, with extensionless relative imports
and `moduleResolution: "Bundler"`.**
NodeNext requires `.js` specifiers that only resolve after a compile step. That
broke `drizzle-kit`'s CJS config loader and the `tsx` migration scripts during
setup. Every tool in this stack (tsx, Vitest, Next's `transpilePackages`, tsup)
understands extensionless imports.
*Consequence:* do not add `.js` to relative imports. Documented in
ARCHITECTURE.md section 2.

**D-09. Postgres on port 5433 and Redis on 6380.**
Off the defaults so a developer's existing local Postgres or Redis cannot be hit
by accident — a `pnpm db:reset` aimed at the wrong database would be
unrecoverable.

---

## Security and privacy

**D-10. Argon2id for passwords; SHA-256 for opaque tokens.**
Different problems. Passwords are low-entropy and user-chosen, so they need a
slow memory-hard hash. Session and invite tokens are 256 bits from a CSPRNG, so
there is nothing to brute-force and lookup must be fast enough for every request.
Using Argon2 for session tokens would add latency for no security gain.

**D-11. Sessions stored as hashes, with a `session_epoch` for mass revocation.**
Reading the database must not yield a usable credential. A single integer bump
revokes every session for a user on password change, role change or suspension,
without scanning and deleting rows.

**D-12. Envelope encryption binds the clinic id as additional authenticated data.**
A per-clinic HKDF-derived key limits blast radius, and the AAD binding means a
ciphertext moved from clinic A's row to clinic B's row fails to decrypt instead of
silently yielding A's secret. This turns a plausible logic bug into a loud error.

**D-13. `CRYPTO_PROVIDER=local` is refused when `NODE_ENV=production`.**
A dev master key that leaks would decrypt every clinic's provider credentials.
Production must use a KMS.

**D-14. The audit trail is append-only at the privilege level.**
`UPDATE` and `DELETE` on `audit_events` are revoked from the application role, so
a fully compromised app process cannot rewrite history. Same reasoning for
revoking `INSERT`/`DELETE` on `clinics`: provisioning a tenant is an operator
action, not something an API bug can do.

**D-15. Marketing analysts get no `people:read` and no `leads:read` capability
at all.**
Rather than granting read and masking fields afterwards, the capability is simply
absent, so no route can return a personal record to that role even by mistake.
Field masking still exists as defence in depth.

---

## Compliance posture

**D-16. All outbound sending is off by default, behind two switches.**
`OUTBOUND_SENDING_ENABLED` is the global kill switch; `CONVERSION_FEEDBACK_ENABLED`
is a stricter one for ad-platform events. The PRD requires that the app be
reviewable with no credentials and that nothing reach a real client before the
clinic approves copy and privacy settings.

**D-17. No hashed email or phone is in the conversion-feedback allowlist.**
Google's customer-data policy states health or medical conversions, including
purchases of medical services, cannot be measured with enhanced conversions.
Hashing does not remove a health-data restriction. Click-ID-only events are used,
and even those need per-destination eligibility review before production.
*Would change if:* the clinic's counsel and the platform both confirm eligibility
for the clinic's exact service and payload, recorded against a specific
`feedback_eligibility_state`.

**D-18. Conversion feedback uses an allowlist, not a denylist.**
A denylist means every new CRM field is transmitted until someone remembers to
block it. The allowlist means a new field is invisible to the adapter until
explicitly approved, with a versioned approved field set.

**D-19. Promotional sending is gated on a per-clinic approval flag.**
`clinics.promotional_sending_approved` defaults to false, including in the seed.
A template classified `promotional` cannot send without it, plus sender identity,
postal address and an unsubscribe mechanism (FTC CAN-SPAM guidance).

**D-20. Seeding refuses to run when `NODE_ENV=production`, and `db:reset` also
refuses a hosted-looking `DATABASE_URL`.**
PRD 9 requires no real client data in development or test. The inverse matters
just as much: no fake data in an environment holding real records.

**D-21. General Notes belong to the person, and never leave the CRM.**
They are internal staff context that may contain sensitive detail even though the
product has no clinical charting. Excluded from ad-platform payloads, automated
message bodies and logs by construction, not by convention.

---

## Testing

**D-22. The RLS isolation suite is treated as the product's load-bearing test.**
It covers fail-closed reads, cross-tenant read and write attempts, the
transaction-scoped tenant setting, and the privilege restrictions. The seed
creates a second clinic specifically so leakage is visible by hand as well as in
CI.
*Rule:* adding a tenant table means adding it to the `tenant_tables` array in
`packages/db/sql/900_rls.sql` and extending this suite.

**D-23. Database tests run against the real Postgres, not a mock or SQLite.**
RLS, exclusion constraints, `set_config` and partial unique indexes are the
things most worth testing, and none of them exist in a substitute engine.

---

## API framework

**D-24. Fastify for the API, replacing the planned NestJS (supersedes D-05).**
NestJS resolves providers from `emitDecoratorMetadata`, which esbuild does not
emit — and esbuild is what tsx, Vitest and tsup all use here. Keeping NestJS would
have meant either SWC plugins throughout the toolchain or `@Inject()` on every
constructor parameter, and its tsc-based build does not handle workspace packages
that ship TypeScript source (D-08).

The reason NestJS was chosen in the first place — one place to attach the
capability check and the tenant transaction — is met by the `registerRoute` helper
in `apps/api/src/route.ts`. Routes declare `auth` and their schemas and receive a
tenant-scoped transaction; there is no way to register a route that skips either,
because `getTx()` only resolves inside the transaction the helper opens. That is a
stronger guarantee than a guard an author can forget to annotate.
*Would change if:* the API grows to need Nest's module ecosystem more than it
needs a fast, dependency-light toolchain.

**D-25. Credential rate limiting is per IP; per-account protection is the login
lockout.**
The first implementation keyed the rate-limit bucket on IP *and* the submitted
email. It silently did nothing: `@fastify/rate-limit` runs in `onRequest`, before
the body is parsed, so `request.body` is undefined and every login collapsed into
one per-IP bucket — which also made the limit far too tight for a clinic behind a
single NAT. Rather than move rate limiting to `preHandler` purely to read an
email, the two concerns are now separated: a coarse per-IP cap (30 per 5 minutes)
stops one host spraying many addresses, and the per-account lockout (5 failures,
15 minutes) stops a targeted attack from anywhere. Both are tested.

**D-26. A foreign record returns 404, not 403.**
RLS hides the row, so the lookup misses and the natural answer is "not found".
Kept deliberately rather than distinguishing the two: replying 403 would confirm
that a record exists, which is itself a disclosure across a tenant boundary.

**D-27. One database transaction per request.**
Gives atomicity and RLS in the same mechanism. The cost is that a slow handler
holds a pooled connection, so long-running work (CSV import, backfill,
reconciliation) belongs in a worker job that opens its own `withTenant` per unit
of work rather than on the request path.

**D-28. Sessions are resolved unscoped, then everything else is scoped.**
A session cookie cannot be looked up inside a tenant transaction because the
clinic is unknown until the row is read. That lookup, the login email lookup and
single-use token redemption are the only three `withoutTenantScope` callers, and
each passes a written reason so review can grep for them.

**D-29. Email is unique per clinic, not globally.**
The same person may work at two clinics on the platform. Login handles the
ambiguity by verifying the password against every match and, if more than one
matches, returning `clinic_selection_required` with the clinic names — disclosed
only after the password is proven, so it tells an attacker nothing they did not
already have.
