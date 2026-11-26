# VPNShop V2 · Product configuration

Apply these settings to Single or Core in `/opt/vpnshop/config/.env`. Use normal CLI preflight and recreate affected application containers with `vpnshop up`. Container recreation reads the new environment. No frontend image rebuild is needed. Upgrades preserve operator files. Edge receives configuration over its established TLS or private Core link, using the same public authority as Single.

| Setting | Default / type | Use and validation |
| --- | --- | --- |
| `BRAND_NAME` | `MZT`, text | Public/Admin API metadata, UI and mail subject. 1–80 characters. Controls and invisible format characters are rejected. The MZT mark and visual assets are unchanged. |
| `SUPPORT_EMAIL`, `SUPPORT_URL` | unset | Optional public address and HTTPS contact. Empty fields omit links. |
| `LEGAL_TERMS_URL`, `LEGAL_PRIVACY_URL`, `LEGAL_REFUND_URL` | unset | Optional public HTTPS links with no embedded credentials. Publish actual terms before authorizing real sales. |
| `REGISTRATION_ENABLED` | `true` | Controls new public email/OIDC signups, including OIDC callbacks started before the change. Existing login, linked identities, verified-address recovery, pending email confirmation and OWNER provisioning remain available. |
| `SUPPORT_ENABLED` | `true` | Controls new tickets. History, replies and resolving open cases continue. Previously accepted idempotency keys may be replayed. |
| `MAINTENANCE_MODE` | `false` | Blocks new public signups, orders, payment attempts and support tickets. The storefront home displays MZT maintenance. Account reads, existing identity operations, billing intake, settlement, background jobs and Admin API continue. |
| `PAYMENTS_ENABLED` | `false` | Authorizes new sales only with an admitted provider and provisioning path. The current real-provider preflight rejects `true`. Prior attempt status, replay, webhook intake and settlement in a configured adapter are outside the admission gate. |
| `REMNAWAVE_ENABLED` | `false` in new templates | Worker claims and external panel calls require the existing isolated staging profile when enabled. An explicit `false` pauses it even with retained staging settings. With the key absent, the previous explicit staging overlay continues to work. |
| `LOG_LEVEL` | `info` | Existing application logger. Values are fatal, error, warn, info, debug, trace and silent. |

Feature switches use exact `true` and `false`. Keep prices, versions and order snapshots in PostgreSQL. Secret file names, role affinity, and conditional mounts remain in [secrets.list](../ops/templates/secrets.list). There is no live provider setting for a contract that has not been admitted.

## Public and administrative contracts

`GET /api/config` returns the allowlisted `{version, product, availability}` with `Cache-Control: no-store`. JSON serialization and the shared schema handle Unicode and quotes as data. There are no URLs for infrastructure, credentials or session data in the response. Edge projects the storefront configuration from Core without environment copies. Browser refresh and periodic revalidation reload changed states. The Admin API serves branding on its own listener and exposes operational settings under the existing `ops:read` status route. The pending external-payment warning also requires `finance:read`. Older frontends keep using the previous API. For split deployment update Core and the Edge proxy to make the new config route available, then verify routing before accepting the new storefront.

## Integrations and staging evidence

- **Remnawave** uses the existing isolated 3.4.9 revision adapter with staging origins, known squad UUIDs, file secrets and a restricted egress overlay. No live compatibility is implied for 2.7.4 or other contracts. With the panel paused, local entitlement projection continues and the worker does not claim external revisions. On resume, active current assignments awaiting a squad profile are projected before external claiming. Existing subscriptions, jobs and finance records are retained. Use an isolated 3.4.9 panel under PASS 06 to verify read metadata, squad identity, a synthetic period, pause, resume, verification and cleanup. [Deployment](V2_DEPLOYMENT.md)
- **Platega** remains contract-blocked. Requests to the site and documentation portal returned proxy HTTP 403 on this pass. Obtain official authentication and create/status/webhook/refund contracts, webhook authentication and replay semantics, currency/amount rules, merchant-account scope, admitted transitions and sandbox credentials. Existing mock tests exercise admission and settlement without real transactions. Doctor and the authorized Admin view flag unresolved legacy/non-mock payments that require operator attention. The feature switch does not reconcile missing provider evidence. [COM-02](payments.md)
- **SMTP** uses `MZT_ENABLE_SMTP_EGRESS`, a verified `MAIL_FROM`, `smtp_url`, and existing `mail_key`. Doctor reports configuration only. For PASS 06 use an isolated relay and disposable recipient. Verify TLS connectivity, SMTP acceptance and eventual inbox delivery separately. [Authentication and support](V2_AUTHENTICATION_SUPPORT.md)
- **Google and Telegram** keep the existing callback, credentials and OAuth egress requirements. Validate authorization and linking with separately registered staging applications, the exact HTTPS callback URLs and a previously linked identity. Verify a recent signed Telegram `auth_time` before marking fresh reauthentication available. Do not enable the verified Telegram gate based on configuration alone. [OAuth configuration](V2_AUTHENTICATION_SUPPORT.md)

The new settings add no database migration. Leave Sentry, bot and provider settings that have no consumer unset. The legacy payment admission default is safe because the preceding release had no admitted real adapter. Switching the deployment or performing live external verification requires the separate PASS 06 rehearsal.
