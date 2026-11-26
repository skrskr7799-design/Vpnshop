# VPNShop V2 · Deployment and configuration

Use the [Master Specification](V2_MASTER_SPEC.md) and [Implementation Plan](V2_IMPLEMENTATION_PLAN.md) for scope and gates. `ops/compose.yml`, the legacy overlays, local staging and existing operational scripts remain available. The V2 modules reuse the existing service definitions with Compose `extends`. The off-site module points to the existing backup overlay. Docker Compose 2.40.3 is the verified local renderer. The modules require Compose support for `extends`, `!reset` and `!override`.

## Select the topology

| Role | Modules | Listeners |
| --- | --- | --- |
| `single` | `core`, `admin`, `edge`, `mode.single` | Storefront and independent admin HTTPS |
| `core` private | `core`, `admin`, `mode.core`, `link.private` | Private Public API and admin HTTPS |
| `core` public | `core`, `admin`, `mode.core`, `link.public` | mTLS Core Gateway and admin HTTPS |
| `edge` private/public | `edge`, `mode.edge`, matching `link.edge.*`, optional private Core CA | Storefront HTTPS |

Public and admin data bridges remain internal and separate. The backup, migration, mailbox, finance and monitoring databases retain their restricted credentials and aliases. No port publishes admin-api, PostgreSQL or metrics. A split Edge has two services, no database bridge and only storefront TLS and transport credentials. Gateway/nginx routes the current public API families, OAuth callbacks and Platega webhook path. Backend authorization and webhook validation remain authoritative.

## Files and preflight

Use the appropriate [Single](../ops/templates/env.single.example), [Core](../ops/templates/env.core.example) or [Edge](../ops/templates/env.edge.example) template for `/opt/vpnshop/config/.env`. Use plain `KEY=value` lines, optionally quoting an entire value, without shell interpolation. The renderer derives internal values. An independently reviewed `release.env` supplies the seven image references as `APPLICATION_IMAGE`, `MIGRATOR_IMAGE`, `DATABASE_IMAGE`, `BACKUP_IMAGE`, `WEB_IMAGE`, `ADMIN_IMAGE` and `EDGE_IMAGE` with immutable `@sha256:` refs. The renderer needs only the images used by the role and overlays. PASS 02 packages this file. See [operator CLI](V2_OPERATIONS.md) and [release process](RELEASE_PROCESS.md).

Provision each required file under `/opt/vpnshop/secrets/` using [secrets.list](../ops/templates/secrets.list). For example, the database gets the restricted-role passwords as UID/GID 999, the Node processes get their own URLs and keys as 1000, and the Nginx TLS files belong to 101. Percent-encode special characters in URL usernames/passwords, generate independent session keys, and provision distinct copies of public certificates for the monitoring UID. On a split Core, the internal exporter reports its administrative certificate; monitor the storefront certificate directly at the remote endpoint. Prepare a distinct client CA for the gateway and issue a dedicated client certificate to the Edge.

Run the entrypoint with Python, Docker Compose and OpenSSL available. To inspect names, scopes and ports without exposing file contents:

```bash
python3 ops/scripts/preflight.py --role single --release-env /absolute/path/release.env --render
```

The same script dispatches Compose only after preflight. Its project is fixed at `vpnshop-<role>`. The stable Compose project directory is `ops/` in this checkout. For a **disposable staging installation**, bring up db, run the one-shot migrator after verifying the backup/state, then start the selected app services:

```bash
python3 ops/scripts/preflight.py --role single --release-env /absolute/path/release.env -- up -d --wait db
python3 ops/scripts/preflight.py --role single --release-env /absolute/path/release.env -- run --rm --no-deps migrator
python3 ops/scripts/preflight.py --role single --release-env /absolute/path/release.env -- up -d --wait
```

Use a privileged operator account that can read protected files. Set the directory to 0700 and each regular file to 0400. Compose's file-backed mounts use bind semantics on Linux; Compose `uid`, `gid` and `mode` options cannot change host file ownership. The preflight maps owners using the daemon's namespace if enabled. Install the vetted edge image in the daemon before this check. A remote daemon or a daemon with a different filesystem requires checking the paths and identities on its own host. `--disposable` is render-only for synthetic CI fixtures and cannot run Compose operations through preflight. Production release and external readiness approval remain separate from syntax and topology validation.

## Host policy for listeners and egress

- **Single:** storefront defaults to loopback on 443. Select a dedicated public interface or configure the host ingress deliberately. Admin remains separate. Both origins must match their requested TLS names.
- **Core/private:** bind `CORE_LISTEN_IP` to the local RFC1918, CGNAT or ULA interface, with `CORE_API_PORT` defaulting to 3000. Edge uses its exact private `CORE_API_ADDR` (bracket IPv6). Limit inbound packets on the published port to `EDGE_PEER_IP` at the host. Verify the observed source inside Public API after Docker NAT. An exact `CORE_PROXY_PEER_IP` override is available if NAT changes it. If a shared NAT/proxy collapses untrusted sources to the same address, isolate the trusted sender with the host firewall or use public mTLS before enabling forwarding trust. Private IPv6 needs a functioning host IPv6/firewall/port-publish path. Protect private transport against untrusted interception.
- **Core/public:** bind the gateway and restrict ingress to the expected Edge address. Set `CORE_API_ALLOWED_IP` to the exact source as observed by Nginx. The raw Edge peer and observed allowlist address may differ when NAT is involved. Edge uses an HTTPS upstream, sends its client key pair and verifies `CORE_API_HOST` using the OS trust store or the optional `core_gw_ca`. The gateway accepts only a client presenting a valid chain from `core_gw_client_ca` and reconstitutes forwarding from the authenticated Edge's single client-address header. Browser forwarding headers are overwritten at the storefront. Match the Core's `PUBLIC_ORIGIN` to the actual storefront origin across machines. A trusted CA and a valid local setting do not establish that the firewall is applied.
- **Admin:** `private` binds a private management interface with explicit CIDRs. `local` binds loopback for an SSH tunnel and still requires effective CIDRs. For a NATed request, include only the observed trusted host address needed by the tunnel. `public` can use a bounded CIDR list or the explicit value `ADMIN_CLIENT_CIDRS=internet`. Empty ACLs are rejected in every mode. The existing rate limits and identity, TOTP and step-up checks still run.
- **Firewall:** enforce ingress on actual published paths. On rootful Docker this generally means filtering forwarded packets (for example `DOCKER-USER` on the iptables backend, or the corresponding nftables chain) in addition to host INPUT policy. On a userland/rootless proxy verify the actual source and ingress path. Apply separate IPv4/IPv6 constraints and test from both an authorized and unauthorized peer before opening a listener. A bridge or an IP allowlist variable alone is not a host firewall.
- **Optional egress:** SMTP gives only notifications a bridge. OAuth gives only Public API a bridge and requires each selected client ID/secret pair. Telegram additionally requires the verified OIDC gate. Panel egress is only the existing explicit staging revision mode with pinned panel compatibility. Off-site storage extends the backup/database topology. Restrict these bridges at the host to the approved DNS resolver and destinations/ports, block access to metadata and management subnets and verify allowed and denied flows. Private listener bridges disable Docker masquerading and still require this host policy. The base process for notifications remains defined and inactive while SMTP is disabled, and the encrypted outbox can continue queuing mail.

## Backup and legacy cutover

Set `MZT_ENABLE_LOCAL_BACKUP=1` and provision `backup_url` and `logical_key` for the on-demand `logical-local` service. It makes an encrypted logical dump, verifies its checksum and decryptability, and saves it in the separate `local-backups` volume. Run with `-- run --rm logical-local`. Local copies are not off-site disaster recovery. Set `MZT_ENABLE_OFFSITE=1` with the documented S3 and pgBackRest inputs for continuous WAL and the existing verified off-site workflow. Initialize and test the stanza/backup before relying on it. Retain the existing schedules and restore drills from [Operations](operations.md).

The V2 key `pgdata` still mounts at `/state/db`; volume identity also depends on the Compose project. The legacy process might use another project name. Starting V2 with the new project name is **a new deployment** and is not a migration procedure. Before cutover capture the installed project and exact volume IDs, verify a restorable encrypted backup, rehearse attaching/importing the existing data on an isolated host and keep the old compose/volumes available. Maintenance downtime, production migration and rollback are separate approved operations. Never replace the active DB volume by starting the new project blindly.

## Acceptance checks

`python3 ops/scripts/test_v2_compose.py -v` renders and checks all roles and overlays and rejects invalid inputs. `python3 ops/scripts/v2_tls_smoke.py` uses isolated Docker networks and test CAs. By default it builds a disposable test image from the pinned Nginx base and the current configs. CI uses `MZT_V2_EDGE_IMAGE` to exercise the actual built image. End-to-end provider, VPN/ACL, off-site storage and existing server cutover remain staging gates. See [release acceptance](release-acceptance.md) for known CRITICAL findings and existing commercial gates.
