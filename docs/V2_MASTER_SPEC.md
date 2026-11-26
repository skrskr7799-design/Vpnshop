# VPNShop V2 · Master Specification

This document defines the approved V2 changes. Existing contracts in [architecture](architecture.md), [release acceptance](release-acceptance.md), [identity](identity.md), [payments](payments.md), and [testing](testing.md) continue to apply. See the [implementation plan](V2_IMPLEMENTATION_PLAN.md) for delivery state and the [development rules](V2_DEVELOPMENT_RULES.md) for permanent constraints.

## Architecture and scope

Keep one repository and seven own OCI images. `application` runs public-api, admin-api, worker, billing and notifications as separate processes. `migrator`, `db`, `backup`, `web`, `admin` and `edge` complete the set. The edge image runs public-edge, admin-edge and core-gateway. Preserve PostgreSQL roles, transactional ledger and entitlements, queue/outbox guarantees, RBAC, security boundaries, existing data, functionality and design. Reuse the current deployment and application. V2 introduces no additional controller, management agent, API gateway application or repository.

| Role | Components | Exposure |
| --- | --- | --- |
| Single | Core, admin, storefront and monitoring | Separate storefront and admin HTTPS listeners. Public-edge connects to public-api:3000 over the internal bridge. No database or API host port. |
| Core | Database, migrator, Public API, workers, admin and monitoring | Private link publishes Public API on a specific private interface, default 3000. Public link publishes only the mTLS core-gateway, default 8443, and the independently configured admin edge. |
| Edge | Storefront web and public-edge | HTTPS storefront only. Public-edge uses the configured Core address. No Core database networks, admin API or credentials, panel/payment secrets or session-signing keys. |

Private links use a dedicated private address and a restricted peer, with NetBird, WireGuard and Tailscale as examples. Verify source IP after Docker NAT before setting the exact trusted proxy. Private addressing alone does not provide encryption. Use a trusted tunnel or the public mTLS link across an untrusted network. Core authentication and allowlisting are independent controls. In public mode Core verifies client certificates and the observed Edge IP. Edge validates the Core trust chain and TLS hostname. Both gateways limit routing to public API, OAuth callback and payment webhook paths and reconstruct forwarding. Host ACLs are required for deployments, particularly Docker-published ports and optional egress. Administrative placement is independently private (default), public with CIDRs or explicit internet access, or local through loopback and an SSH tunnel. Keep login rate limits, session controls and critical-action reauthentication.

## Configuration and secrets

The operator settings file is `/opt/vpnshop/config/.env`; templates are role-specific. Compose project, release image digests, secret directory, process flags, internal interfaces, database URLs and trusted proxy mappings are supplied by deployment tooling. File names and ownership are in [secrets.list](../ops/templates/secrets.list). The [V2 deployment guide](V2_DEPLOYMENT.md) specifies the working PASS 01 settings, TLS and firewall policy. Public origins must be HTTPS and separate from the admin origin. Checkout defaults to 30 minutes and admin sessions to 12 hours with a 30-minute idle limit. Provision only the active role's required secrets. Generate separate role credentials, percent-encode URL passwords, and use distinct JWT and cookie secrets. The directory mode is 0700 and secret files are 0400. Match effective container owners including Docker namespace mapping. Preflight is required before startup. Keep the legacy entrypoints, volume keys and schemas available through a separately rehearsed cutover. Local encrypted logical backup is available without S3. Off-site backup, SMTP, OAuth and isolated panel egress are opt-in.

## Approved follow-up capabilities

### Administration and identity (PASS 03)

Admin sign-in uses username with safe migration of existing staff accounts. Add local bootstrap and recovery for the first OWNER and prevent removal of the last active OWNER. Only OWNER can create staff or ordinary users in the admin panel and assign or change staff roles. User creation supports email plus a temporary password or a one-time password setup link. Preserve existing RBAC and immutable administrative audit. Support staff session management and 2FA reset. Implement independent `required`, `optional` and `disabled` 2FA policies for all admin placements. Warn about a publicly exposed admin UI with 2FA disabled and allow deliberate use. Preserve step-up for critical actions, using a secure alternative when TOTP is disabled.

### Authentication and support (PASS 04)

Email registration requires confirmation by email or manual activation. Manual activation does not verify ownership of an email address. A successfully verified Telegram identity can activate the account, and Google activation requires verified identity and verified email. Safely link providers to existing accounts without merging by matching email. Preserve users and data. Extend existing support with categories, priorities, assignee, unread counters, notifications and closure. Preserve conversations, state, and per-user data isolation. Attachments and a separate realtime chat are outside scope.

### Product configuration and integrations (PASS 05)

Support settings without image rebuilds for registration, payments, auth providers, integrations, support and maintenance. The initial deployment can run without Remnawave. A verified provider contract and test data precede any real Platega integration. Disabling new payments preserves ingress, refunds, prior financial obligations and already paid orders. Keep provider mocks separate from operational readiness. Build runtime frontend configuration with compatible public contracts.

Reserved settings and initial values, to be introduced only when consumed by the corresponding implementation:

- Feature switches `PAYMENTS_ENABLED=false`, `REGISTRATION_ENABLED=true`, `MAINTENANCE_MODE=false`, `GOOGLE_AUTH_ENABLED=false`, `TELEGRAM_AUTH_ENABLED=false`, `SUPPORT_ENABLED=true`, `REMNAWAVE_ENABLED=false`, `ADMIN_2FA_POLICY=required`.
- Product metadata `BRAND_NAME`, `SUPPORT_EMAIL`, `SUPPORT_URL`, `LEGAL_TERMS_URL`, `LEGAL_PRIVACY_URL`, `LEGAL_REFUND_URL`.
- Runtime settings `LOG_LEVEL=info`, `SENTRY_DSN`, `TELEGRAM_BOT_TOKEN`, `RATE_LIMIT_*`, `DB_POOL_MAX`. Secret-valued settings are backed by files.
- Integration settings `PLATEGA_*` depend on the provider contract. Reserved live Remnawave settings include `REMNAWAVE_URL`, `REMNAWAVE_INTERNAL_SQUAD_UUIDS` and `REMNAWAVE_TRUSTED_PROXY_HEADERS=false` with operator tokens and API keys. PASS 01 only wires the existing, pinned isolated staging mode.

## Installer and release contract (PASS 02)

One Bash script named `vpnshop` is installed at `/usr/local/bin/vpnshop`. The installation uses `/opt/vpnshop/releases/`, `current`, `previous`, `config/.env`, `secrets/`, `backups/` and `state/`. State includes `role`, `history.log`, `update.lock`, `applied-migration-tree`, `last-successful-release` and `pending-update`. Compose project `vpnshop-<role>` and data volume paths are stable across releases. Keep an absolute, stable Compose project directory. The installed role is immutable in the normal workflow.

Commands are `install`, `up`, `down`, `restart`, `update`, `rollback`, `status`, `doctor`, `backup`, `restore`, `admin bootstrap`, `admin recover`, `compose`, `help`. Root/sudo, `flock`, `umask 077` and safe failures are required. Install prepares without starting services. Update preserves the settings and secrets and requires a verified backup before schema changes. Recover interrupted updates using durable state. Rollback checks schema compatibility. Clean older releases after success while retaining `current` and `previous`.

CI publishes digest-pinned GHCR images with provenance. Reuse verified digests when image-specific build inputs are unchanged. Hash common dependencies, lockfiles, Dockerfiles, base images and all relevant sources. Git ancestry supplements input verification. A frontend-only change cannot trigger a database rebuild by itself. Support future private GitHub and GHCR access. Keep current API compatibility with the preceding frontend, or document a coordinated upgrade.

GitHub Releases publish `vpnshop.sh`, `vpnshop.sh.sha256`, `vpnshop-deploy-vX.Y.Z.tar.gz`, and its `.sha256`. The source-free archive contains Compose, monitoring, templates, scripts, `release.env`, `NOTES.md`, and the script. Release metadata contains image digests and nonsecret settings. Notes list changed images, migrations, settings, compatibility, update steps and rollback conditions. A production or commercial rollout requires separate release approval and evidence.
