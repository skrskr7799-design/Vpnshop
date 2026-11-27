# VPNShop V2 release process

Use [V2 deployment](V2_DEPLOYMENT.md) for topology, secrets and host policy and [V2 CLI](V2_OPERATIONS.md) for installation and recovery. The existing release acceptance and supply-chain gates still apply. See [release acceptance](release-acceptance.md).

## Create a release

The protected `release-registry` environment must require the repository owner's authorization and allow only `main`. Enable immutable releases in the GitHub repository before the first production publication. A release manager on `main` dispatches **Publish authorized VPNShop release** with a new `vX.Y.Z`, the previous attested release version (or `first-release` for the initial V2 release), and the notes JSON below. Review GitHub's required environment protections and keep the GHCR packages linked to this repository. The working-branch workflow is read-only and uploads synthetic artifacts.

```json
{
  "changes": "Describe user-visible and operational changes.",
  "settings": "List each new or changed option, or explicitly state none.",
  "secrets": "List only names, scope and when provisioning is needed.",
  "compatibility": "Document schema and previous frontend/API compatibility and the evidence.",
  "coordination": "compatible",
  "update": "Give the actual role-specific sequence and maintenance prerequisites.",
  "downtime": "State which writers or services must be stopped and which timings were observed.",
  "rollback": "Specify which prior release qualifies and what requires a forward fix.",
  "known_issues": "List applicable release and external gates."
}
```

Set `coordination` to `coordinated` when Core and Edge need a specific order or a shared maintenance window. Document the affected API contracts and both rollout directions in the notes. For an independently tested rollback between two compatible releases, add `"rollback_compatible_with": "<predecessor version> <full predecessor commit SHA>"` to the release notes JSON. Release generation verifies both values against the attested predecessor and records the reverse-direction declaration inside the attested archive. Without that declaration, or when either release calls for coordination, split rollback requires an explicit order and confirmation on each host.

The workflow runs Toolchain CI, computes fingerprints, builds changed targets and verifies smoke, PostgreSQL restore and PITR, then runs the Trivy, dependency and secret gates. Both built and reused targets are tested under the candidate's local aliases. It validates the archive and launcher before writing images to the existing GHCR namespaces. Newly built images get an attempt-specific registry tag and deployment records the verified digest. The release verifies image config IDs, platform and source labels. The two primary artifacts receive GitHub provenance attestations. The workflow verifies both, scans the kit for secrets, creates a tag at the tested SHA and verifies all four draft assets after upload before publishing.

The default rejects an existing tag or release. Use the explicit `resume` input after an interrupted attempt only when the tag points to the same commit. A draft must match the title, notes and checksums of every existing asset. The workflow uploads only missing files, verifies the complete draft again and then publishes it. Published releases are immutable. A mismatch, unexpected asset, or unavailable permission blocks resumption. A rebuild can produce different digests. Keep the interrupted draft for investigation and choose a fresh version if the verified bytes cannot be reproduced.

## Rehearsal and diagnostics

The read-only **VPNShop release rehearsal** workflow builds the seven images from the release worktree and runs the same migration, restore, PITR, TLS and scan commands as publication. Python contract tests run the production planner, registry digest verification, bundler and publication logic using memory-backed command responses. They cover the first release, permission errors, tag conflicts, partial uploads, altered assets and retries. Real GHCR permissions, GitHub attestation issuance and GitHub Release writes require separately authorized external verification.

Release and rehearsal diagnostics retain stage statuses, vulnerability IDs, package versions and npm counts. Raw scanner JSON, image history, scanner matches, Docker credentials and release notes are excluded from the diagnostic artifacts. Production audit findings, image secrets and all image CRITICAL findings outside the temporary Bookworm policy block publication. Use the full dependency audit to track advisories in development tooling separately.

## Build inputs and artifacts

The production builder uses a detached clean worktree at the verified commit. The Dockerfile stage graph determines the digest of each target's reachable instructions, base images and copied tracked files. SHA-256 covers file content and executable mode, builder frontend, Docker ignore rules, build driver and architecture. Lockfile and all workspace manifests affect the common install. Sources for each frontend and the backend are copied into their own branches of the graph. Shared sources affect the consumers that bundle them. Schema and migrations affect application and migrator. The database and backup stages have their own inputs. Only the OCI source revision label receives the Git SHA. Unknown build instructions with unresolved inputs are rejected until the planner supports them. The current release platform is `linux/amd64`.

Reuse requires a prior attested archive from this repository and this workflow, an ancestor source commit, an exact input fingerprint, a pullable digest and matching registry platform and source/revision labels. Missing digests or mismatched inputs rebuild. Debian uses dated signed distribution and security archives in `ops/build/*.sources`. APT disables the historical archive expiry check for those sources and retains signature and HTTPS verification. Failure to load any archive fails the build. Nginx inherits Alpine packages, including patched libxml2, from its pinned base digest. These locks fix system package inputs. Bit-for-bit image reproducibility remains unverified.

For a security refresh, review package advisories and changes, advance the Debian snapshot timestamps or the pinned base digests for the affected targets, then run the build, scan and deployment checks. A snapshot change invalidates the stages that copy it and their consumers. The release `refresh` switch rebuilds all images from the committed inputs. Scanning remains mandatory on every release attempt.

The archive contains only the launcher and deployment assets. Entries are ordered and have normalized USTAR and gzip metadata. Each artifact has a checksum. `release.env` contains the version, source SHA, seven immutable image references and migration tree hash. `release-images.json` records each image's source SHA, fingerprint, digest reference and build or reuse decision, along with rollout coordination and platform. The migration tree uses SHA-256 of the canonical migration name-to-SQL-checksum map. Editing, dropping or inserting a historical migration ahead of the previous release is rejected. Updates additionally compare applied checksums in PostgreSQL. Keep the attested archive, its checksum and the release notes for each installed version.

A SHA-256 sidecar fetched from the same release verifies integrity. For independent authentication verify the GitHub provenance or use a digest verified on a separate trusted channel. Verify the standalone script before first execution. Run the following with a GitHub CLI version that supports attestations.

```bash
sha256sum -c vpnshop.sh.sha256
gh attestation verify vpnshop.sh --repo skrskr7799-design/Vpnshop \
  --signer-workflow skrskr7799-design/Vpnshop/.github/workflows/release-images.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

### Temporary Bookworm risk policy

The v2.0.0 database stays on PostgreSQL 17 and Debian Bookworm. Three exact Debian CVE, package and installed-version combinations can pass the gate only in the Linux amd64 `db` and `backup` images. This approval expires at **2027-05-27 00:00 UTC**. Trivy keeps the findings at CRITICAL and the gate reports them individually as accepted risk.

Each release and rehearsal scans with a fresh Trivy cache. An exception requires advisory data issued within the last seven days with the known Debian status and no reported fixed version. It also requires the installed version to match the newest version in the live, signed Debian Bookworm, updates and security indexes. A changed package version, fix in Trivy, unexpected status, stale data or failure to verify the signed indexes blocks the exception. Packages are checked in a disposable unprivileged container without changing the pinned build inputs. All unrelated CRITICAL findings continue to block.

When a fix becomes available, refresh the pinned PostgreSQL base or Bookworm snapshot as appropriate, rebuild the affected images, confirm the findings are gone, and rerun PITR and the release rehearsal. See the [release audit](V2_RELEASE_SECURITY_AUDIT.md) for the exact entries and residual risks.
