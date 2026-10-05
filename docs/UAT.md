# Pilot UAT — the 15 PRD scenarios

How each PRD §9 scenario is covered today. **Automated** = a test in
`apps/api/src/__tests__` runs it on every CI build. **Manual** = a person must
do it against the real accounts during the pilot. Fill in the "Pilot result"
column with the clinic.

| # | Scenario | Covered by | Status before pilot | Pilot result |
|---|---|---|---|---|
| 1 | A test lead from Meta, click-to-WhatsApp, Google, website; one walk-in; check source and timestamps | `integrations.test.ts`, `intake.test.ts`, `leads.test.ts`; Settings "Send a test lead" | ✅ Automated on mocks · Manual with real accounts | |
| 2 | Same webhook delivered twice → one submission, no duplicate email | `integrations.test.ts` (Meta redelivery), `intake.test.ts`, `automations.test.ts` ("never twice") | ✅ Automated | |
| 3 | Second inquiry, same phone → separate lead, shared person | `intake.test.ts`, `inbox.test.ts` | ✅ Automated | |
| 4 | Route and reassign; queue, timeline and audit history | `leads.test.ts` (assignment), Settings → Lead rules, Audit log | ✅ Automated + screen | |
| 5 | Overlapping booking refused; reschedule cancels the old reminder | `calendar.test.ts` (exclusion constraint), `automations.test.ts` (reminder moves/stops) | ✅ Automated | |
| 6 | Unsubscribe before a queued promotional email → suppressed with reason | `inbox.test.ts` (unsubscribe), `messaging.test.ts` (consent gate) | ✅ Automated | |
| 7 | Booking/converting stops irrelevant follow-up | `automations.test.ts` ("stops when they book") | ✅ Automated | |
| 8 | Provider outage, recover, replay, no lead loss | `integrations.test.ts` (retry with backoff); events stay queued and visible | ✅ Automated · Manual: stop Meta access, restore, watch Settings | |
| 9 | Practitioner / marketing analyst can't see forbidden fields or export | `people.test.ts`, `reports.test.ts`, RBAC tests | ✅ Automated | |
| 10 | Dashboard counts reconcile with lists and CSV | `reports.test.ts`, Reports screen | ✅ Automated + screen | |
| 11 | Connect the clinic's existing WhatsApp Business number | Manual only — needs Meta's coexistence onboarding | ⬜ Pilot | |
| 12 | Duplicate WhatsApp webhooks → one message; free-form in/out of window; template | `inbox.test.ts`, `integrations.test.ts` | ✅ Automated on mocks · Manual with real number | |
| 13 | Qualified twice + replay → one feedback event | `feedback.test.ts` ("one event per milestone…") | ✅ Automated · Manual with real accounts in test mode | |
| 14 | Unapproved feedback mapping / forbidden field blocked | `feedback.test.ts` (health-word event name refused; unreviewed queues nothing; allowlisted payload) | ✅ Automated | |
| 15 | Pinned General Note visible on other leads; edit/archive audited; never in messages | `people.test.ts`, `messaging.test.ts` (render excludes notes), Notes section | ✅ Automated | |

## Release gates (PRD 9) — status

| Gate | Status |
|---|---|
| Reliability — no acknowledged event lost | ✅ Durable `inbound_events` queue with retries |
| Freshness — lead within 5 min p95 | ✅ Worker polls every 5 s; alerts if backlog > 10 min |
| UI response — 2 s p95 | ✅ 68 ms p95 at 20 users (`scripts/load-check.mjs`) |
| Availability 99.5% | Depends on hosting; uptime monitoring in DEPLOYMENT.md §6 |
| Backup + restore test | ✅ Restore drill passed 2026-09-29 (all row counts match); repeat on the server |
| Accessibility — WCAG 2.2 AA | ✅ axe scan: 0 violations on every main screen, light and dark (2026-09-27). Manual screen-reader pass still recommended |
| Privacy — no real data in dev | ✅ Seed refuses production; production refuses dev secrets |
| Observability alerts | ✅ `apps/api/src/ops/monitor.ts` + `/health/alerts` |

Browser coverage: `apps/web/e2e/front-desk.spec.ts` (walk-in → book → confirm
→ Won) runs in CI on every push.

## Channel sync acceptance (D-90)

Use [INTEGRATION_SYNC.md](INTEGRATION_SYNC.md) for prerequisites. The automated
`channel-sync.spec.ts` runs only with mock providers and replaces demo account
settings; always use a disposable database. Real pilot evidence is still needed:

| Scenario | Automated coverage | Real pilot evidence |
| --- | --- | --- |
| Admin connects Page, Google customer/manager and WhatsApp number | OAuth/signup + channel-sync browser flow | Provider approval and chosen account IDs verified |
| Connected datasets/actions selected without copying tokens | ad-sync API + browser | Accessible real dataset and offline action visible |
| Returning WhatsApp ad inquiry stays on current lead | ad-sync API | Original source retained; genuine ctwa_clid captured |
| Both enabled Meta paths tested separately | ad-sync API + browser | Correct test code and event in each dataset |
| Google validated and final processing checked | ad-sync API + HTTP adapter | Validate-only succeeds, real upload reaches accepted/diagnostic result |
| Reconnect/settings changes do not retarget waiting outcomes | ad-sync API + feedback regression | Queued outcomes canceled; fresh tests required |
| New Google form linked; other CRM endpoint preserved | ad-sync API | Real new-form delivery and conflict shown |
| Incoming and outbound failures retried without duplicate data | ad-sync API | Failure fixed; same original destination/event ID |
