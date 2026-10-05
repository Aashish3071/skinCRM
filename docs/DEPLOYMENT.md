# Deploying SkinCRM

For whoever runs the server. Everything here was tested on 2026-09-27: the
production images build and boot, the backup/restore test passes, and the load
check passes (p95 68 ms at 20 concurrent users on a laptop).

## Before you start: decisions only the clinic can make

- **HIPAA status.** If the clinic is a covered entity, every vendor that
  stores or sees data — the server host, email relay, backup storage, error
  monitoring — must sign a BAA *before* real data goes in (PRD 8). AWS, Google
  Cloud and Azure sign BAAs; so do SES and Postmark on the right plans.
- **Backups.** Agree the RPO/RTO with the clinic (this setup gives RPO ≤ 24 h
  with daily backups; see "Backups" to tighten it).
- **Region.** Host in the US for a Florida clinic unless counsel says otherwise.

## 1. Server

One Linux VM is enough for a clinic: 2 vCPU, 4 GB RAM, 40 GB disk, with Docker
and the compose plugin. Open ports 80 and 443 only. Point a DNS record
(e.g. `crm.yourclinic.com`) at it.

## 2. Configuration

```bash
git clone https://github.com/Aashish3071/skinCRM.git /srv/skincrm && cd /srv/skincrm
cp .env.example .env
```

Edit `.env` — every value below matters in production:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (the compose file also forces it) |
| `APP_DOMAIN` | `crm.yourclinic.com` (Caddy gets the certificate) |
| `PUBLIC_WEB_URL`, `PUBLIC_API_URL` | `https://crm.yourclinic.com` (both — Caddy routes webhooks to the API) |
| `POSTGRES_PASSWORD`, `DATABASE_APP_PASSWORD` | `openssl rand -base64 32` each |
| `SESSION_SECRET`, `CRYPTO_MASTER_KEY` | `openssl rand -base64 32` each, **different**. Keep `CRYPTO_MASTER_KEY` in a password manager too: losing it makes every stored integration token unreadable |
| `CRYPTO_PROVIDER` | `local` (D-75; the app refuses to start with a weak key) |
| `OUTBOUND_SENDING_ENABLED` | `true` once the clinic has signed off |
| `CONNECTOR_EMAIL`, `SMTP_*`, `EMAIL_FROM_*` | `live` and your relay (SES, Postmark…). Not `localhost` — the app refuses |
| `CONNECTOR_WHATSAPP`, `CONNECTOR_META`, `CONNECTOR_GOOGLE` | `live` once the apps in §4 exist |
| `META_APP_ID`, `META_APP_SECRET` | from the Meta app (§4). The secret also verifies webhook signatures |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Connect with Google Ads; Ads/Data Manager APIs enabled in the Cloud project (§4) |
| `OPS_ALERT_EMAIL` | where operational alerts go |
| `MONITOR_TOKEN` | `openssl rand -base64 32`, for your uptime monitor |
| `BACKUPS_EXPECTED` | `true` once the backup cron is in place |

The API **refuses to start** in production with development placeholders, weak
or reused secrets, or email pointing at the development mail catcher. That is
deliberate; read the error, fix the value.

## 3. Start

```bash
cd deploy
docker compose -f docker-compose.prod.yml --env-file ../.env up -d --build
docker compose -f docker-compose.prod.yml logs -f api worker
```

`migrate` runs first (schema, the application database role, row-level
security) and must succeed before `api` and `worker` start. Then open
`https://crm.yourclinic.com`.

**First clinic and admin:** the demo seed refuses to run in production. Create
the clinic with the tools image; it prints a one-time invite link for the admin
(valid 7 days) and never asks you for their password:

```bash
docker compose -f docker-compose.prod.yml --env-file ../.env run --rm migrate \
  pnpm db:create-clinic --name "Bright Skin Miami" --slug bright-skin-miami \
  --timezone America/New_York --branch "Miami — Brickell" \
  --admin-email owner@brightskin.com --admin-name "Jamie Rivera"
```

Send the link to the admin; they set a password and two-step sign-in, then
invite everyone else from Settings → Staff. Run the same command for each
additional clinic on this server.

## 4. Connect the accounts (Settings → Lead sources & messaging)

Clinics connect Facebook and Google themselves with **Connect with Facebook** and
**Connect with Google Ads** — sign in, pick the Page / ad account, done. For
that to work, you (the operator) set up two apps **once per deployment**:

**Meta app (Connect with Facebook)** — developers.facebook.com
1. Create a Business-type app; add **Facebook Login for Business** and **Webhooks**.
2. Valid OAuth redirect URI: `https://crm.yourclinic.com/settings/integrations/oauth/meta/callback`.
3. Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`,
   `leads_retrieval`, `business_management`, `ads_management`. Complete **Business Verification** and
   **App Review** for Advanced Access — until then only people with a role on the
   app can connect (fine for a first pilot clinic whose admin you add as a tester).
   Optionally create a Login for Business configuration with these permissions
   and set `META_LOGIN_CONFIG_ID`.
4. Webhooks → Page → subscribe `leadgen` with the Callback URL and Verify token
   shown under "Technical details". Each clinic's Page is then subscribed
   automatically when they connect.
5. `.env`: `CONNECTOR_META=live`, `META_APP_ID`, `META_APP_SECRET`.
6. Test with Meta's Lead Ads Testing Tool after a clinic connects.

**Google (Connect with Google Ads)** — console.cloud.google.com + ads.google.com
1. Enable the **Google Ads API** and **Data Manager API** on the OAuth client’s Cloud project. Create an **OAuth client (Web application)**
   with redirect URI `https://crm.yourclinic.com/settings/integrations/oauth/google/callback`.
   Configure/publish consent for `…/auth/adwords` and `…/auth/datamanager`.
   Existing customers must reconnect to grant the added Data Manager scope.
2. Confirm the Cloud project has the required Google Ads/Data Manager access.
   [Google’s access policy](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
   replaces developer-token access; the legacy token setting is optional.
3. `.env`: `CONNECTOR_GOOGLE=live`, `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`.
4. **Verify before go-live:** connect a real test account and press "Send test
   data" on one of its lead forms in Google Ads; the lead must appear in Leads.
   The lead-form webhook update is written against the API reference and has
   only run against fakes (`packages/connectors/src/oauth/google.ts`).
5. The same connection supplies verified conversion actions and feedback credentials
   in Settings → Ad platform feedback. Follow [INTEGRATION_SYNC.md](INTEGRATION_SYNC.md),
   including validate-only and a real upload checked through processing diagnostics.

A form that already sends leads to another system (a previous CRM, Zapier) is
left alone and listed, never overwritten. The manual routes — pasting a Page
token, or a webhook key into the form — remain under "…by hand instead".

**WhatsApp (Connect WhatsApp — Embedded Signup)** — same Meta app
1. Add the **WhatsApp** product. Become a Tech Provider (or Solution Partner) and
   get `whatsapp_business_management` and `whatsapp_business_messaging`
   approved in App Review.
2. WhatsApp → **Embedded Signup** → create a configuration (Login for Business,
   "WhatsApp Embedded Signup" variation). Put its id in `META_WA_CONFIG_ID`.
3. Facebook Login for Business → **Allowed domains for the JavaScript SDK**:
   add `crm.yourclinic.com` (the popup is opened from Settings in the browser).
4. Webhooks → WhatsApp Business Account → subscribe `messages` with the Callback
   URL and Verify token shown in Settings. Each clinic's WABA is then subscribed
   automatically when they connect.
5. `.env`: `CONNECTOR_WHATSAPP=live`, `META_APP_ID`, `META_APP_SECRET`, `META_WA_CONFIG_ID`.
6. **Pilot the clinic's existing number** with "The number we already use"
   (coexistence: the WhatsApp Business app keeps working on the phone). Meta
   decides eligibility; if it refuses the number, the fallback is a new number.
   Approve message templates in WhatsApp Manager.

- **Email:** "Send yourself a test". Set up SPF/DKIM for the sending domain
  with your relay first, or mail will land in spam.

## 5. Backups (PRD 9)

```cron
15 3 * * *  cd /srv/skincrm && BACKUP_PASSPHRASE=... scripts/backup.sh >> /var/log/skincrm-backup.log 2>&1
```

- The scripts find the database container on their own (set `PG_CONTAINER`
  only if you renamed it) and read `POSTGRES_*` from `.env` as plain data.
- `scripts/backup.sh` streams `pg_dump` through AES-256 into `backups/`,
  keeps 14 days, and records success so the monitor alerts if backups stop.
- **Copy `backups/` off the server** (e.g. `aws s3 sync` to a bucket with
  object lock). A backup on the same disk is not a backup.
- **Restore test before launch, then monthly:** `scripts/verify-backup.sh`
  restores the newest backup into a scratch database and compares row counts.
- **Real restore:** `scripts/restore.sh <file>` restores into a *new*
  database (never over the live one); point the app at it and run `migrate`.

## 6. Monitoring (PRD 9)

- **Uptime:** point UptimeRobot / Better Stack at
  `https://crm.yourclinic.com/health/alerts` with header `x-monitor-token`.
  200 = fine; 503 = something needs attention (the body says what).
- **Email alerts** to `OPS_ALERT_EMAIL`, at most hourly per problem: worker
  stopped, incoming leads/messages backed up or failing, a connected account
  in error, an ad account silent for 7 days, email failures, missed backups.
- **Readiness:** `/health/ready` returns 503 when the database or the worker is down (use it for load balancers); `/health` is liveness only.
- Logs are JSON on stdout with personal data redacted; ship them to your log
  service if it has a BAA.

## 7. Updating

```bash
cd /srv/skincrm && git pull
cd deploy && docker compose -f docker-compose.prod.yml --env-file ../.env up -d --build
```

Migrations run automatically. Take a backup first.

## 8. Load check (staging only)

```bash
LOAD_EMAIL=... LOAD_PASSWORD=... node scripts/load-check.mjs https://staging.example.com 20 30
```

Fails if p95 exceeds 2 s or more than 1% of requests fail.


## D-91 rollout: delivery receipts and customer controls

Run the normal migration command before replacing the API/worker. Migrations
0014–0016 and the current RLS script are required. Keep the worker enabled: it
reconstructs message history after interrupted requests and never resends an
uncertain provider call. Budget an additional ten application-role connections
per process for the independent receipt pool, alongside the existing pools.

An admin can inspect **Automations → Sent messages → Delivery needs review**.
Check the external provider's history before recording an outcome. Accepted
requires its provider message ID. Confirming "not sent" does not resend; staff
can deliberately compose another message after that verification. Receipts
contain encrypted recovery content and must remain in database backups with the
clinic encryption key available to the restore environment.

For templates, connect the WhatsApp business account, approve a supported text
template in WhatsApp Manager, then **Load templates and refresh approvals** and
map/import its variables. Check a real recipient and delivery status before
turning on reminders. An unsupported format is shown explicitly instead of
being imported as if it were sendable.
