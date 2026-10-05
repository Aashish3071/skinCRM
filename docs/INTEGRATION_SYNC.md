# Channel integration and conversion sync

Implemented 2026-10-01 (D-90). This guide describes the current supported scope and the live-account launch checks.

## What connects

Each clinic has one active Facebook Page, one Google Ads customer account (including access through a manager) and one WhatsApp business number. Replacing a connection replaces the previous one for that channel. Credentials are encrypted per clinic and never included in browser responses. Only admins can configure or retry integrations.

| Channel | Into CRM | Back to advertising |
| --- | --- | --- |
| Facebook / Instagram | New lead-form inquiries, provider lead ID and available ad attribution | Selected funnel milestones through Conversions API, matched with Meta lead ID |
| Google Ads | Lead-form inquiries, campaign/form IDs and gclid when supplied | Selected funnel milestones through Data Manager, matched with gclid and an enabled offline conversion action |
| WhatsApp | New messages and conversations; organic inquiries or click-to-WhatsApp ad inquiries | Opted-in ad milestones through the business account's dataset, matched with the genuine ctwa_clid and WhatsApp business account ID |

This is continuous event sync for new inquiries and future CRM milestones, not a general replica of ad accounts. It does not import spend, rewrite campaign settings, sync historic chats/contacts or upload patient/contact lists as audiences. Those capabilities are not implemented. Campaign optimisation still depends on account eligibility, matched identifiers, goal configuration and sufficient conversion volume; an API acceptance is not a guarantee of attribution or delivery.

The payloads exclude names, email, phone, services, conditions and notes. Google uses click IDs only. A WhatsApp post referral without an ad click remains organic. An ad message from an existing contact is attached to their existing open lead, retaining the new attribution without changing the original lead source. Campaign reporting and CSV attribution show the latest recorded ad inquiry; original-source reporting remains unchanged.

## Customer setup

1. Settings → **Lead sources & messaging**: Connect with Facebook, Connect with Google Ads, and Connect WhatsApp. Choose the clinic's Page, ad account and number. Existing WhatsApp Business numbers use the existing coexistence path when eligible.
2. Settings → **Ad platform feedback**: **Load connected accounts**. Choose an accessible Facebook/Instagram dataset, use the connected Google account, and/or **Connect WhatsApp outcomes**. WhatsApp uses its own business account dataset and encrypted token; it can run without a Facebook Page connection. Facebook and WhatsApp test codes are separate, from their respective datasets in Events Manager.
3. Select milestones. For Google, select an enabled offline conversion action from the connected account; its owning customer is verified and saved. Avoid mapping both Qualified and Booked because they happen together. WhatsApp has separate supported event names (`LeadSubmitted` / `ViewContent`); the supported non-purchase events do not require fabricated revenue.
4. Complete the existing privacy/platform review. This enables testing only.
5. In live mode, first receive a genuine inquiry carrying that channel's matching ID, then send a test event. Google uses validate-only; Meta uses the dataset's test code. Synthetic examples are only sent through mocks. Facebook and WhatsApp each require a successful test if both paths are enabled.
6. Confirm the result in Events Manager / Google Ads, then **Go live**. Only future milestones are created; older outcomes are not backfilled. Events created while in test mode stay in test mode if the destination is subsequently promoted.

## Operations and recovery

- Incoming provider webhooks are authenticated and deduplicated before tenant-scoped processing. The UI shows recent incoming events; **Retry** requeues failed events without creating a duplicate submission or message.
- **Check connection** reports credential/permission problems. Google OAuth lead forms are also checked hourly by the worker. New forms are linked automatically when empty; a webhook owned by another tool is preserved and surfaced as needing attention. A Google reconnect to the same account preserves the delivery key, so existing form endpoints remain usable.
- Outbound feedback has stable IDs, retries with backoff and visible rejection reasons. Eligible blocked/rejected events can be retried only against the same configuration and non-test lead. Mapping/account/credential changes cancel waiting events and require fresh tests; reconnect/disconnect also revoke approval for linked destinations.
- Google live uploads are initially **Google processing** (`sent`), then the worker checks request status after 30 minutes and hourly while still processing. It never resends during diagnostics polling. `accepted` means Google reports success; `rejected` includes provider diagnostics. If the original connection has been replaced, inspect Google Ads for an already-uploaded event because the CRM cannot check its original request with the new authority.
- Meta, Google and WhatsApp connector modes are independent. Mocks do not send to providers. `CONVERSION_FEEDBACK_ENABLED` controls conversion sending separately from messaging's `OUTBOUND_SENDING_ENABLED`.
- Run the worker continuously. Webhooks receive new events; this implementation does not backfill missed historical provider submissions. Alerting, retention and backup procedures remain in [DEPLOYMENT.md](DEPLOYMENT.md).

## Operator prerequisites and live launch checks

See [DEPLOYMENT.md](DEPLOYMENT.md) §4. Supply public HTTPS callbacks, reviewed/approved Meta permissions and a published Google OAuth consent screen. Enable both Google Ads API and Data Manager API on the OAuth client's Cloud project. OAuth scopes are `adwords` and `datamanager`; existing Google connections must reconnect to grant the added permission. Google Ads requests use v25. A legacy developer-token setting is optional; project access must satisfy Google's current access policy.

Verify these with a real clinic before selling this as a live integration:

- Facebook customer sign-in, Page subscription, lead receipt, dataset visibility and a test CAPI outcome.
- Google customer/manager selection, existing and newly created form delivery, conversion-action ownership, validate-only response, then one approved real milestone through upload and processing diagnostics.
- WhatsApp Embedded Signup and number ownership/coexistence, organic message receipt/reply, a real click-to-WhatsApp referral, business dataset creation/access and a test outcome with the correct test code.
- Disconnect/reconnect and permission revocation recovery, tenant isolation and production worker health. Keep all customer sending gates off until the account's review and tests pass.

Local automated tests exercise mocked OAuth/providers and live HTTP adapters with fake responses. They do not certify provider app review, account permissions or real campaign attribution.

## Provider references

- [Google Data Manager ingest](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest), [destinations](https://developers.google.com/data-manager/api/reference/rest/v1/Destination), [processing diagnostics](https://developers.google.com/data-manager/api/devguides/diagnostics).
- [Google Ads version lifecycle](https://developers.google.com/google-ads/api/docs/sunset-dates) and [API access policy](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).
- [Meta Business API specification](https://github.com/facebook/facebook-business-sdk-codegen/blob/main/api_specs/specs/Business.json), [WhatsApp business account dataset specification](https://github.com/facebook/facebook-business-sdk-codegen/blob/main/api_specs/specs/WhatsAppBusinessAccount.json) and [Meta WhatsApp webhook examples](https://www.postman.com/meta/whatsapp-business-platform/folder/1dtuocp/messages-object).
