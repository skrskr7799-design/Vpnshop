# VPNShop V2 · Implementation Plan

See [Master Specification](V2_MASTER_SPEC.md) and [Development Rules](V2_DEVELOPMENT_RULES.md). Baseline is main with MZT DES‑03 at `5b89a3d`.

| Pass | Delivery and acceptance | Dependencies | Status |
| --- | --- | --- | --- |
| 01 · Deployment & Configuration | Modular Compose for three roles and both link modes, separate admin access policy, role-specific settings/secrets, deployment preflight, synthetic Compose and TLS checks. Preserve old entrypoints and storage. | Docker Compose, OpenSSL, Python, pinned images for container smoke. Real transports, firewall and production storage have separate staging gates. | IMPLEMENTED · evidence below |
| 02 · Release Engineering & CLI | Digest reuse by complete image inputs, reproducible release archive, local CLI, bootstrap/recover commands, lock and recovery state, verified backup prerequisite and schema-safe rollback. | Verified PASS 01, GHCR write access, role bootstrap integration from PASS 03. | IMPLEMENTED · synthetic and CI evidence below |
| 03 · Administration & Identity | Username migration, protected OWNER, staff/user creation, explicit 2FA policy and equivalent protected step-up, sessions and audit. | PASS 01 access modes, local command contract PASS 02, existing staff identity and RBAC. | IMPLEMENTED · verification below |
| 04 · Authentication & Support | Email/manual activation, verified Google and Telegram paths, safe linking, support assignment/unread/notifications and isolation. | PASS 03 owner capabilities. SMTP is optional. Live SMTP and OIDC acceptance require approved test credentials. | IMPLEMENTED · live verification pending |
| 05 · Product Configuration & Integrations | Runtime flags and metadata, gates for new payments only, optional panel and verified provider integration. | PASS 01 overlays, PASS 03–04 roles/auth; confirmed Platega test contract and isolated Remnawave panel. | PLANNED |
| 06 · Integration & Release Preparation | Cross-pass end-to-end acceptance, versioned artifacts, backup/restore, upgrade/rollback, safe legacy cutover rehearsal, external readiness evidence. | PASS 01–05, approved isolated staging and legacy fixture. | PLANNED |
| 07 · Astra Final Audit | Independent assessment of application, integrations, financial integrity, auth, infrastructure and release evidence. Commercial decision by owner. | Accepted PASS 06 candidate and the external gates. | PLANNED |

## PASS 01 evidence and boundaries

- Configuration, deployment entrypoint, inventory, compatible legacy composition and disposable test suites are versioned. See [V2 deployment guide](V2_DEPLOYMENT.md). Provider egress configuration is separate from live provider acceptance.
- Local evidence includes 11 matrix tests with all five selected role/link configurations, admin placement, IPv6 rendering, overlays, legacy Single comparison and unsafe configurations. The Docker transport smoke used the pinned upstream Nginx base with the current gateway/front-door code. It verified private forwarding, valid mTLS, missing client certificate, ACL, wrong CA/SNI and public route isolation. The complete built-image/Single/backup test is a separate [GitHub Actions job](https://github.com/skrskr7799-design/Vpnshop/actions/workflows/v2-deployment.yml).
- Local package verification covered locked install, Oxlint, the network policy unit tests and frontend/shared packages. Prisma generation was blocked by HTTP 403 fetching the official checksum. Local release edge build was blocked by HTTP 403 for the Alpine package index. No integrity or security checks were disabled.
- A disposable PostgreSQL 17 instance also exercised the local backup script using the existing backup runtime. The encrypted output passed checksum, decryption and archive-read checks without an S3 connection.
- Real peer identity after Docker NAT, host ACLs, TLS names at issued endpoints, and tested off-site storage are staging dependencies. Live Remnawave, Platega and production migration remain outside this pass. Existing release blockers and the commercial NO-GO remain in [release acceptance](release-acceptance.md).

## PASS 02 evidence and boundaries

The protected release workflow and source-free CLI use the existing topology, preflight, migrator, logical backup and recovery scripts. The [release process](RELEASE_PROCESS.md) describes fingerprint inputs, digest reuse, manifest validation and accepted operator evidence. The [CLI runbook](V2_OPERATIONS.md) covers independent role installation, recovery and database rollback. The read-only [branch CI](https://github.com/skrskr7799-design/Vpnshop/actions/workflows/v2-deployment.yml) checks deterministic artifacts, deployment cases and isolated PostgreSQL restore with synthetic credentials. Production GHCR publication, protection configuration and attestation verification are external checks. Existing release acceptance blockers remain. OWNER bootstrap/recovery require PASS 03 and actual legacy cutover requires PASS 06.

## PASS 03 implementation

The [administration runbook](V2_ADMINISTRATION.md) covers migration, OWNER bootstrap and recovery, staff and customer commands, session policy and rollback. Toolchain CI uses real PostgreSQL for authentication, command locking and legacy migration. Deployment CI checks policy placement, built admin commands and source-free CLI. Chromium uses synthetic operator scenarios. Live identity providers and the existing-server cutover remain subsequent gates.


## PASS 04 implementation

The [authentication and support runbook](V2_AUTHENTICATION_SUPPORT.md) records SMTP optionality, OAuth configuration, account linking, read positions, case triage and the additive database migration. Branch CI exercises existing workflows with synthetic identity providers, a disposable PostgreSQL instance, the three deployment roles and Chromium evidence. Live Google and Telegram claims, fresh Telegram reauthentication and mail relay delivery still require isolated credentials and operator acceptance. The existing-server upgrade and compatibility rehearsal remain in PASS 06.
