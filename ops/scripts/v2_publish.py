#!/usr/bin/env python3
"""Commit the attested release assets to GitHub without replacing an existing release."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from release_bundle import REPOSITORY, ReleaseError, checksum, demand, digest_file, unpack, version
from v2_release import production, run


def require_absent(endpoint):
    response = run(["gh", "api", "--include", endpoint], check=False, capture_output=True)
    status = response.stdout.splitlines()
    demand(response.returncode != 0 and status and len(status[0].split()) >= 2 and status[0].split()[1] == "404",
           "The release or tag already exists, or GitHub failed to confirm its absence")


def check(tag, resume=False):
    sha = production()
    # Authenticated release listing includes drafts. A release-by-tag lookup
    # alone cannot establish that an interrupted draft is absent.
    listing = run(["gh", "api", "--paginate", "--slurp", f"repos/{REPOSITORY}/releases"],
                  capture_output=True).stdout
    releases = [entry for page in json.loads(listing) for entry in page if entry["tag_name"] == tag]
    demand(len(releases) <= 1 and (not releases or resume and releases[0]["draft"] is True),
           "Release already exists. Published releases cannot be changed.")
    endpoint = f"repos/{REPOSITORY}/git/ref/tags/{tag}"
    if not resume:
        require_absent(endpoint)
        return sha, None, False
    ref = run(["gh", "api", "--include", endpoint], check=False, capture_output=True)
    if ref.returncode == 0:
        tag_commit(tag, sha)
    else:
        status = ref.stdout.splitlines()
        demand(status and len(status[0].split()) >= 2 and status[0].split()[1] == "404" and not releases,
               "Cannot establish ownership of the interrupted release tag")
    return sha, releases[0] if releases else None, ref.returncode == 0


def tag_commit(tag, sha, create=False):
    endpoint = f"repos/{REPOSITORY}/git/refs"
    if create:
        run(["gh", "api", "--method", "POST", endpoint,
             "-f", f"ref=refs/tags/{tag}", "-f", f"sha={sha}"], capture_output=True)
    target = run(["gh", "api", f"repos/{REPOSITORY}/git/ref/tags/{tag}", "--jq", ".object.sha"],
                 capture_output=True).stdout.strip()
    demand(target == sha, "The release tag does not point to the candidate commit")


def verify_remote_assets(tag, files, directory):
    if not files:
        return
    directory.mkdir()
    download = ["gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", str(directory)]
    for file in files:
        download += ["--pattern", file.name]
    run(download)
    demand(all(digest_file(directory / file.name) == digest_file(file) for file in files),
           "Uploaded draft assets differ from the verified release")


def draft_asset_names(draft, tag, notes, files):
    names = {asset["name"] for asset in draft["assets"]}
    demand(len(names) == len(draft["assets"]) and names <= {file.name for file in files}
           and draft["body"].rstrip("\n") == notes.read_text().rstrip("\n") and draft["name"] == f"VPNShop {tag}",
           "Interrupted draft contains unexpected metadata or assets")
    return names


def publish(tag, directory, resume=False):
    sha, draft, tagged = check(tag, resume)
    archive = directory / f"vpnshop-deploy-{tag}.tar.gz"
    script = directory / "vpnshop.sh"
    assets = [archive, script]
    checks = [asset.with_name(asset.name + ".sha256") for asset in assets]
    for asset, proof in zip(assets, checks, strict=True):
        checksum(asset, proof)
        run(["gh", "attestation", "verify", str(asset), "--repo", REPOSITORY,
             "--signer-workflow", f"{REPOSITORY}/.github/workflows/release-images.yml",
             "--source-ref", "refs/heads/main", "--source-digest", sha, "--deny-self-hosted-runners"])
    with tempfile.TemporaryDirectory() as staging:
        dest = Path(staging)
        extracted = dest / "verified"
        extracted.mkdir()
        values, _, _ = unpack(archive, extracted)
        demand(values["VPNSHOP_VERSION"] == tag and values["GIT_SHA"] == sha and
               digest_file(extracted / script.name) == digest_file(script), "Release assets do not match source and standalone CLI")
        scan = "zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9"
        run(["docker", "run", "--rm", "--network", "none", "-u", f"{os.getuid()}:{os.getgid()}",
             "-v", f"{extracted}:/release:ro", scan, "dir", "--no-banner", "--redact=100", "/release"])
        files = assets + checks
        notes = extracted / "NOTES.md"
        if not tagged:
            tag_commit(tag, sha, create=True)
        if draft:
            names = draft_asset_names(draft, tag, notes, files)
            verify_remote_assets(tag, [file for file in files if file.name in names], dest / "existing")
            missing = [file for file in files if file.name not in names]
            if missing:
                run(["gh", "release", "upload", tag, *map(str, missing), "--repo", REPOSITORY])
        else:
            run(["gh", "release", "create", tag, *map(str, files), "--repo", REPOSITORY,
                 "--draft", "--verify-tag", "--title", f"VPNShop {tag}", "--notes-file", str(notes)])
        verify_remote_assets(tag, files, dest / "complete")
        final_sha, final_draft, _ = check(tag, resume=True)
        demand(final_sha == sha and final_draft is not None and
               draft_asset_names(final_draft, tag, notes, files) == {file.name for file in files},
               "The draft changed after verification")
        run(["gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=false"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "publish"])
    parser.add_argument("tag", type=version)
    parser.add_argument("directory", type=Path, nargs="?")
    parser.add_argument("--resume", action="store_true", help="Resume only an exact matching unpublished attempt")
    args = parser.parse_args()
    try:
        if args.action == "publish":
            publish(args.tag, args.directory, args.resume)
        else:
            check(args.tag, args.resume)
    except ReleaseError as problem:
        sys.exit(str(problem))
    except (subprocess.CalledProcessError, OSError, ValueError):
        sys.exit("GitHub release operation failed. Inspect the draft before attempting a new publication.")
