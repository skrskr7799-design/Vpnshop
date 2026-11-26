# VPNShop V2 · Implementation Plan

See [Master Specification](V2_MASTER_SPEC.md) and [Development Rules](V2_DEVELOPMENT_RULES.md). Baseline is main with MZT DES‑03 at `5b89a3d`.

| Pass | Delivery and acceptance | Dependencies | Status |
| --- | --- | --- | --- |
| 01 · Deployment & Configuration | Modular Compose for three roles and both link modes, separate admin access policy, role-specific settings/secrets, deployment preflight, synthetic Compose and TLS checks. Preserve old entrypoints and storage. | Docker Compose, OpenSSL, Python, pinned images for container smoke. Real transports, firewall and production storage have separate staging gates. | IMPLEMENTED · evidence below |
| 02 · Release Engineering & CLI | Digest reuse by complete image inputs, reproducible release archive, local CLI, bootstrap/recover commands, lock and recovery state, verified backup prerequisite and schema-safe rollback. | Verified PASS 01, GHCR write access, role bootstrap integration from PASS 03. | IMPLEMENTED · synthetic and CI evidence below |
| 03 · Administration & Identity | Username migration, protected OWNER, staff/user creation, explicit 2FA policy and equivalent protected step-up, sessions and audit. | PASS 01 access modes, local command contract PASS 02, existing staff identity and RBAC. | IMPLEMENTED · verification below |
| 04 · Authentication & Support | Email/manual activation, verified Google and Telegram paths, safe linking, support assignment/unread/notifications and isolation. | PASS 03 owner capabilities. SMTP is optional. Live SMTP and OIDC acceptance require approved test credentials. | IMPLEMENTED · live verification pending |
| 05 · Product Configuration & Integrations | Runtime flags and metadata, gates for new payments only, optional panel and verified provider integration. | PASS 01 overlays, PASS 03–04 roles/auth; confirmed Platega test contract and isolated Remnawave panel. | IMPLEMENTED · provider acceptance pending |
| 06 · Critical Delta Audit & Remediation | Independent fixed-range audit and remediation of its six findings. Final development pass. | PASS 01–05, Toolchain CI, Deployment CI. Separate operational acceptance covers provider and VPS evidence. | Audit complete · remediation verification below |

## PASS 01 evidence and boundaries

- Configuration, deployment entrypoint, inventory, compatible legacy composition and disposable test suites are versioned. See [V2 deployment guide](V2_DEPLOYMENT.md). Provider egress configuration is separate from live provider acceptance.
- Local evidence includes 11 matrix tests with all five selected role/link configurations, admin placement, IPv6 rendering, overlays, legacy Single comparison and unsafe configurations. The Docker transport smoke used the pinned upstream Nginx base with the current gateway/front-door code. It verified private forwarding, valid mTLS, missing client certificate, ACL, wrong CA/SNI and public route isolation. The complete built-image/Single/backup test is a separate [GitHub Actions job](https://github.com/skrskr7799-design/Vpnshop/actions/workflows/v2-deployment.yml).
- Local package verification covered locked install, Oxlint, the network policy unit tests and frontend/shared packages. Prisma generation was blocked by HTTP 403 fetching the official checksum. Local release edge build was blocked by HTTP 403 for the Alpine package index. No integrity or security checks were disabled.
- A disposable PostgreSQL 17 instance also exercised the local backup script using the existing backup runtime. The encrypted output passed checksum, decryption and archive-read checks without an S3 connection.
- Real peer identity after Docker NAT, host ACLs, TLS names at issued endpoints, and tested off-site storage are staging dependencies. Live Remnawave, Platega and production migration remain outside this pass. Existing release blockers and the commercial NO-GO remain in [release acceptance](release-acceptance.md).

## PASS 02 evidence and boundaries

The protected release workflow and source-free CLI use the existing topology, preflight, migrator, logical backup and recovery scripts. The [release process](RELEASE_PROCESS.md) describes fingerprint inputs, digest reuse, manifest validation and accepted operator evidence. The [CLI runbook](V2_OPERATIONS.md) covers independent role installation, recovery and database rollback. The read-only [branch CI](https://github.com/skrskr7799-design/Vpnshop/actions/workflows/v2-deployment.yml) checks deterministic artifacts, deployment cases and isolated PostgreSQL restore with synthetic credentials. Production GHCR publication, protection configuration, attestation verification and legacy cutover remain external checks. OWNER bootstrap and recovery were delivered in PASS 03.

## PASS 03 implementation

The [administration runbook](V2_ADMINISTRATION.md) covers migration, OWNER bootstrap and recovery, staff and customer commands, session policy and rollback. Toolchain CI uses real PostgreSQL for authentication, command locking and legacy migration. Deployment CI checks policy placement, built admin commands and source-free CLI. Chromium uses synthetic operator scenarios. Live identity providers and the existing-server cutover remain subsequent gates.


## PASS 04 implementation

The [authentication and support runbook](V2_AUTHENTICATION_SUPPORT.md) records SMTP optionality, OAuth configuration, account linking, read positions, case triage and the additive database migration. Branch CI exercises existing workflows with synthetic identity providers, a disposable PostgreSQL instance, the three deployment roles and Chromium evidence. Live Google and Telegram claims, fresh Telegram reauthentication, mail delivery and the existing-server rehearsal require separate operational acceptance.


## PASS 05 implementation

[Product configuration](V2_PRODUCT_CONFIGURATION.md) records runtime metadata, Core-owned admission gates, optional integrations and the staged cutover contract. Platega contract and sandbox remain externally blocked. Live Remnawave, SMTP, Google and Telegram remain external acceptance checks.

## PASS 06 final development pass

The independent audit compared `5b89a3d28e6c4ccc0d4579e4c3bce48e4f66e3e2` with `3b9d6cfec7d7eccb7ed6fb96ab1770ff4941fa3d`. Remediation adds restore quarantine and explicit reconciliation, inactive Compose service cleanup, directional split rollback approval, authoritative Google email handling, locked system package inputs and preserved Edge API errors. The release and operations guides record the new controls and test boundaries.

Local checks covered the release and CLI suite, Compose matrix, Google claims and Nginx transport smoke. Deployment CI includes the full disposable PostgreSQL restore and SMTP overlay transition. The managed proxy denied local downloads of the Debian snapshot and Prisma engine checksum. Exact release-image and full Toolchain CI evidence therefore require the branch runs on the remediation commit.

Operational acceptance is separate from development. It still includes exact candidate validation, approved VPS transport and failover rehearsal, legacy cutover, live provider evidence and the existing release gates. Publishing the working branch leaves production release and rollout subject to separate authorization.
