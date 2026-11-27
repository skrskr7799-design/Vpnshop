# VPNShop V2 operator CLI

The verified standalone Bash launcher needs Python 3.11+, Docker Engine with Compose 2.40+, curl, tar, OpenSSL, sha256sum and flock. Use sudo/root on the deployment host. The distribution uses ready-made image digests. See [release process and launcher verification](RELEASE_PROCESS.md).

## Install and operate

```bash
sudo ./vpnshop.sh install v2.0.0 --role single
sudo vpnshop doctor
sudo vpnshop up
sudo vpnshop status
```

Use `--role core` or `--role edge` for split deployment and follow their transport and TLS requirements. `install` prepares the installation without starting workload services. Fill in `/opt/vpnshop/config/.env` using the installed role template and provision the applicable operator secrets. Single and Core templates enable local logical backup by default and require an independently stored `logical_key`. Edge generates no Core credentials. For rootless ownership mapping the installer may need to pull a vetted edge image and run a short isolated UID probe. See [network and secret setup](V2_DEPLOYMENT.md).

State, backup archives, config and secrets remain outside the releases. `current` and `previous` are validated relative links. Each role keeps its stable Compose project, volume names and project directory. File-backed monitoring config paths are keyed by content so a release-directory change does not recreate monitoring services. Existing volume names must be mapped in a rehearsed legacy migration. Install refuses known existing VPNShop Compose resources. During PASS 06 inventory the actual old project and volumes, keep its credentials and certificates, rehearse a verified restore and reconcile queues and financial history on the isolated target before switching. See [legacy cutover requirements](V2_DEPLOYMENT.md#backup-and-legacy-cutover).

`up` checks effective permissions and prerequisites, obtains required image digests, runs a migrator for new PostgreSQL only and waits for readiness and HTTPS. `down` preserves named volumes, `restart [service]` waits for readiness. `status` and `doctor` are read-only. They report unavailable checks separately. A private admin ACL may permit only TLS probing from Core itself. Provider calls are not part of diagnostics. `compose ps|images|top|port` and `compose config --services` provides a bounded operator view without volume deletion or service mutations. `admin bootstrap`, `admin recover` and `admin list` use the installed admin runtime. See [OWNER operations](V2_ADMINISTRATION.md).

For private GitHub, use `--github-token-file /protected/read-token` with a root-owned file accessible only by root and repository contents read access. Use `--attest` with a recent authenticated GitHub CLI or `--sha256` with a trusted preverified archive digest. Without either flag the CLI reports GitHub HTTPS and checksum verification only. Private GHCR uses separate read-only registry credentials and Docker's credential store. Pass the token via stdin and run commands with the same Docker config.

```bash
sudo sh -c 'docker login ghcr.io --username "$1" --password-stdin < /protected/ghcr-read-token' sh OPERATOR
```

## Update, rollback and recovery

```bash
sudo vpnshop update latest --dry-run
sudo vpnshop update v2.1.0 --attest
sudo vpnshop rollback
sudo vpnshop recover
```

The dry run downloads and validates the archive, renders the target using preflight, checks the active PostgreSQL history and disk space, and prints image differences and operational notes. It does not pull images or change release pointers. Actual update verifies secrets and obtains target images before confirmation. Database changes require typing the target version even with `--yes`. The CLI drains known writers and validates an encrypted safety backup before changing the database image or applying migrations. For other changes, Compose reconciles the service configurations without global recreation. The deployment waits for healthchecks and HTTPS readiness. Status may report degraded health until the endpoint is reachable. Keep a known compatible Core/Edge window or follow the maintainer's coordinated sequence.

If interrupted, inspect `vpnshop status` and `state/pending-update`. Keep writers stopped when an unresolved migration or restore is present. `recover` resumes the documented intent, checks real PostgreSQL state, and requires explicit confirmation. `recover --cancel` returns to the old release only if the current pointer, active DB identity and PostgreSQL history still match. A dirty Prisma migration needs a site-specific forward recovery process before retry. A regular rollback only accepts identical applied migration checksums and the same DB image. It preserves the current dataset, external intents, operator config and secrets. An incompatible rollback needs a forward fix or an explicitly approved recovery with potential data loss.

Independent Core/Edge rollback requires both releases to be marked compatible and the current release to declare reverse compatibility with the exact target commit. Otherwise review both releases' notes and run `sudo vpnshop rollback --order core-first` or `sudo vpnshop rollback --order edge-first` on each host in the selected sequence. Type the target version followed by the order when prompted. The CLI checks the local transition and leaves coordination across hosts to the operator.

Lifecycle reconciliation stops and removes inactive containers in the selected Compose project without removing volumes. Turning off the mail overlay stops SMTP delivery and retains the database outbox and internal support events. Re-enabling the overlay starts delivery on the existing queue.

## Backup and restore

`vpnshop backup` uses the existing `logical-local` encrypted backup process and stores the archive and verified metadata in `/opt/vpnshop/backups/<backup-id>/`. With off-site enabled it also runs the existing separate verified S3 logical backup. The local archive metadata records the release, PostgreSQL version, schema, key version, checksum and archive-read result. Keep the matching encryption key and protected copies of config, credentials and TLS material separately. The garbage collector only prunes old installed releases. Use the existing storage retention and PITR process. The logical backup and verification require the backup container's bounded tmpfs to fit the dump. For larger datasets size the backup storage through a reviewed deployment change or use the existing pgBackRest path. See [operations and PITR](operations.md).

`vpnshop restore <backup-id>` accepts a CLI-managed logical archive with compatible PostgreSQL and the exact migration history. It verifies checksum, key and archive before prompting for the literal backup ID. The command removes all project workload containers except PostgreSQL without removing volumes, takes a safety backup, restores into a scratch database, invalidates restored sessions and challenges, suppresses replayable mail and applies verify-first recovery. It swaps database names transactionally and keeps the prior database with connections disabled. Recovery identifies both databases by OID and ends in `awaiting-reconciliation`. The durable journal blocks ordinary lifecycle commands. Removing the workload containers prevents Docker from bringing them back through restart policies.

1. Run `vpnshop status` or `vpnshop doctor` for the retained database name, safety backup and restore ID. If interrupted, run `vpnshop recover` with the original backup ID. It keeps workloads quarantined. If PostgreSQL is stopped, start only the existing DB container locally and resume.
2. Use the PostgreSQL socket inside the DB container for read-only inspection. Restore the safety backup separately on an isolated target to inspect post-backup events. During review `vpnshop admin list` and `vpnshop admin recover` provide local access to existing OWNER accounts. Compare account roles, blocks, password rotations, TOTP and revoked credentials with post-backup records and reapply changes or rotate affected credentials. Reconcile payment and provisioning evidence through the existing [operations procedure](operations.md#восстановление-на-отдельном-стенде).
3. After reconciliation run `sudo vpnshop restore-finish <restore-id>` and type the displayed ID when prompted. Keep panel egress disabled until recovery is complete. The CLI verifies both database identities and the safety backup before starting workloads. If startup fails, it quarantines workloads again. The old database is retained for separate operator cleanup.

Edge has no local database. Use the existing PITR or off-site procedure for other backup formats.

State and history record operation phases, release versions, changed images and backup IDs without secrets. A separate recovery window and verified backups are required for an existing production cutover. Release acceptance and commercial launch gates remain separate. See [release acceptance](release-acceptance.md).
