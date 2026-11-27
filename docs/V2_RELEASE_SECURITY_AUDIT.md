# VPNShop v2.0.0 release security audit

The [failed release](https://github.com/skrskr7799-design/Vpnshop/actions/runs/45949187569/job/140342820661) ran from main at `3211e5532dc9d8ffa1af32873f62603b089060d6`. The [read-only reproduction](https://github.com/skrskr7799-design/Vpnshop/actions/runs/45952713527/job/140352028251) rebuilt all seven images and reproduced the database and backup findings with the existing gate. It passed migration and restore smoke, S3 PITR and TLS, then retained sanitized diagnostic reports after Trivy blocked the candidate.

| CVE | Package and version in db and backup | Bookworm result | Upstream boundary | After this change |
| --- | --- | --- | --- | --- |
| CVE-2023-45853 | zlib1g `1:1.2.13.dfsg-1` | `will_not_fix`, no fixed package reported | MiniZip affected through zlib 1.3 | CRITICAL remains visible. Exact entry temporarily accepted |
| CVE-2025-7458 | libsqlite3-0 `3.40.1-2+deb12u2` | `affected`, no fixed package reported | SQLite 3.41.2 | CRITICAL remains visible. Exact entry temporarily accepted |
| CVE-2026-6653 | libxml2 `2.9.14+dfsg-1.3~deb12u6` | `fix_deferred`, no fixed package reported | libxml2 2.11.0 outside the affected range | CRITICAL remains visible. Exact entry temporarily accepted |

The signed Bookworm, updates and security indexes returned these same installed versions on 2026-11-27. The owner approved keeping the pinned Bookworm base, PostgreSQL 17 and the pgBackRest runtime. No database base or installed OS package changed. The release gate reads the unfiltered Trivy results and independently checks the newest signed Bookworm versions before allowing these entries. An advertised fix, a changed package version, missing signed evidence, stale Trivy data or **2027-05-27 00:00 UTC** ends acceptance. All six findings remain in the diagnostics and are identified separately from blocking findings. [Release policy](RELEASE_PROCESS.md#temporary-bookworm-risk-policy)

| CVE | Applicability and compensating measures | Residual risk |
| --- | --- | --- |
| CVE-2023-45853 | The affected ZIP writer belongs to MiniZip. The images contain zlib for compression and no separate MiniZip package. No reachable application ZIP-write path has been identified | A bundled MiniZip copy or a future archive-writing consumer could expose the affected code |
| CVE-2025-7458 | SQLite is present through local tooling including GnuPG in backup. No path from a store client to arbitrary SQLite queries has been identified. PostgreSQL connections use the PostgreSQL engine and scoped DB roles | A compromised container, local operational input or new SQLite consumer could expose the library |
| CVE-2026-6653 | PostgreSQL and pgBackRest link libxml2. Database XML processing requires database access. pgBackRest parses S3 response XML. Access is restricted by private networks, scoped DB roles and verified TLS to trusted offsite storage | A compromised database role, S3 endpoint or TLS trust chain can still expose the parser. A process failure may affect availability or the recovery-point objective |

Compose tests cover Single, Core and Edge across both supported link modes, including optional archive egress on the database roles. They check Docker publishes no PostgreSQL port, the database shares no network with ingress proxies, database bridge networks are internal, and Edge contains neither a database nor its secrets. Keep firewall and private-link policy in effect on each VPS. [Prior package and collation investigation](release-acceptance.md#rel-01--проверка-critical-в-postgresql-и-backup).

Separate local npm audit found two HIGH advisories in Prisma tooling. A scoped override updates `deepmerge-ts` 7.1.5 → 8.0.0 (GHSA-ggr8-5vv4-36mx) and `effect` 3.21.0 → 3.22.1 (GHSA-7589-6fvf-x4pw). After regenerating the lockfile, the production audit exited 0 with no findings and the full audit exited 0 at the existing HIGH threshold with one LOW.

| Stage | Evidence and change | Boundary |
| --- | --- | --- |
| Checkout, worktree, permissions, clean inputs | Existing release file-mode and fingerprint tests plus read-only runner build of the seven pinned targets | Production checkout requires the protected main workflow |
| PostgreSQL migrations, Single/CLI smoke, PITR, TLS | Read-only rehearsal runs the same commands as production and verified the unchanged PostgreSQL 17 and pgBackRest path | A replacement database base requires a new recovery and storage-compatibility drill |
| Security and evidence | Same Trivy, Gitleaks and pnpm gates for premerge and production. Failure artifacts carry fixed stage names, vulnerability metadata and audit counts. A failed image export or scan is recorded and blocks release | Only the documented temporary exact matches can pass. The signed-index lookup and all other CRITICAL and secret findings retain a blocking path |
| Registry push, digests and provenance | Contract tests run the production publish and verify functions with denied writes and mismatched config IDs. Push tags are scoped to the run attempt. Production pinning uses digest | Live registry permissions, namespace writes and digest round trip need the protected workflow |
| Manifest and deploy artifacts | Contract rehearsal runs first-release planning and production bundle generation twice and compares the launcher, archive and checksum bytes. Bundle validation runs before registry writes | Rebuilding an OCI image can change its digest |
| Attestation | Contract tests require signer workflow, main ref and exact source SHA, and abort before a tag write on attestation failure | GitHub issuance and remote verification need the protected workflow |
| Tag, draft, assets, publication | Contract tests cover version conflicts, partial upload, tag-only retry and corrupted draft files. Resume is explicit, validates the exact tag and existing draft bytes, and uploads only missing files | Real mutable-draft operations and final release transition require the protected workflow |

The rehearsal workflow has read-only repository permissions. It uses public image and advisory pulls and exercises external writes through command contracts. It has no release environment, registry login, production push, tag creation or release publication.
