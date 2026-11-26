#!/usr/bin/env python3
"""Commit the attested release assets to GitHub without replacing an existing release."""
import argparse
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


def check(tag):
    sha = production()
    require_absent(f"repos/{REPOSITORY}/releases/tags/{tag}")
    require_absent(f"repos/{REPOSITORY}/git/ref/tags/{tag}")
    return sha


def publish(tag, directory):
    sha = check(tag)
    archive = directory / f"vpnshop-deploy-{tag}.tar.gz"
    script = directory / "vpnshop.sh"
    assets = [archive, script]
    checks = [asset.with_name(asset.name + ".sha256") for asset in assets]
    for asset, proof in zip(assets, checks, strict=True):
        checksum(asset, proof)
        run(["gh", "attestation", "verify", str(asset), "--repo", REPOSITORY,
             "--signer-workflow", f"{REPOSITORY}/.github/workflows/release-images.yml",
             "--source-ref", "refs/heads/main", "--deny-self-hosted-runners"])
    with tempfile.TemporaryDirectory() as staging:
        dest = Path(staging)
        extracted = dest / "verified"
        extracted.mkdir()
        values, _, _ = unpack(archive, extracted)
        demand(values["VPNSHOP_VERSION"] == tag and values["GIT_SHA"] == sha and
               digest_file(extracted / script.name) == digest_file(script), "Release assets do not match source and standalone CLI")
        run(["gh", "release", "create", tag, *map(str, assets + checks), "--repo", REPOSITORY,
             "--draft", "--target", sha, "--title", f"VPNShop {tag}", "--notes-file", str(extracted / "NOTES.md")])
        download = ["gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", staging]
        for file in assets + checks:
            download += ["--pattern", file.name]
        run(download)
        demand(all(digest_file(dest / file.name) == digest_file(file) for file in assets + checks),
               "Uploaded draft assets differ from the verified release")
        run(["gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=false"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "publish"])
    parser.add_argument("tag", type=version)
    parser.add_argument("directory", type=Path, nargs="?")
    args = parser.parse_args()
    try:
        if args.action == "publish":
            publish(args.tag, args.directory)
        else:
            check(args.tag)
    except ReleaseError as problem:
        sys.exit(str(problem))
    except (subprocess.CalledProcessError, OSError, ValueError):
        sys.exit("GitHub release operation failed. Inspect the draft before attempting a new publication.")
