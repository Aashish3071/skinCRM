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
| `CONNECTOR_WHATSAPP`, `CONNECTOR_META` | `live` once the accounts are connected |
| `META_APP_ID`, `META_APP_SECRET` | from the Meta app. The secret is what verifies webhook signatures |
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

- **Facebook / Instagram lead ads:** page ID + page access token. In the Meta app,
  subscribe the page to `leadgen` with the Callback URL and Verify token shown
  under "Technical details". Test with Meta's Lead Ads Testing Tool.
- **Google Ads lead forms:** Create key → paste the webhook URL and key into the
  lead form asset → "Send test data".
- **WhatsApp:** phone-number ID + permanent token; subscribe `messages` with the
  URL and token shown. Approve message templates in WhatsApp Manager.
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
