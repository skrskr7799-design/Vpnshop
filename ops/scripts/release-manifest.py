#!/usr/bin/env python3
"""Verify an exported OCI bundle and record the original local image identities."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile

archive, revision, output, *previous = sys.argv[1:]
if not re.fullmatch(r"[a-f0-9]{40}", revision):
    raise SystemExit("Expected a complete commit SHA")
targets = ("application", "migrator", "web", "admin", "edge", "db", "backup")


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read(bundle, name):
    member = bundle.extractfile(name)
    if member is None:
        raise ValueError("Missing regular archive member")
    return member


with tarfile.open(archive, "r:") as bundle:
    index = json.load(read(bundle, "index.json"))
    images = {}
    verified = set()

    def descriptor(item, *, decode=False):
        sha = item["digest"]
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", sha):
            raise ValueError("Invalid OCI descriptor digest")
        stream = read(bundle, "blobs/sha256/" + sha[7:])
        if decode:
            contents = stream.read()
            if len(contents) != item["size"] or digest(contents) != sha:
                raise ValueError("OCI JSON descriptor integrity mismatch")
            return json.loads(contents)
        if sha not in verified:
            if bundle.getmember("blobs/sha256/" + sha[7:]).size != item["size"] or hashlib.file_digest(stream, "sha256").hexdigest() != sha[7:]:
                raise ValueError("OCI layer integrity mismatch")
            verified.add(sha)
        return None

    for item in index["manifests"]:
        name = item["annotations"]["io.containerd.image.name"].rsplit("/", 1)[-1]
        target = name.removeprefix("mzt-ci-").removesuffix(":" + revision)
        if target not in targets or target in images or name != "mzt-ci-" + target + ":" + revision:
            raise ValueError("Unexpected or duplicate image")
        manifest = descriptor(item, decode=True)
        config = descriptor(manifest["config"], decode=True)
        if config["config"]["Labels"]["org.opencontainers.image.revision"] != revision:
            raise ValueError("Image revision mismatch")
        for layer in manifest["layers"]:
            descriptor(layer)
        images[target] = {"ociManifest": item["digest"], "imageConfig": manifest["config"]["digest"],
                          "platform": config["os"] + "/" + config["architecture"], "localTag": name}
if set(images) != set(targets):
    raise ValueError("Missing candidate image")
root = Path(".")
migrations = sorted((root / "apps/api/prisma/migrations").glob("*/migration.sql"))
assert migrations
manifest = {
    "version": 1,
    "environment": "isolated-ci",
    "gitSha": revision,
    "lockfile": digest((root / "pnpm-lock.yaml").read_bytes()),
    "node": (root / ".node-version").read_text().strip(),
    "packageManager": json.loads((root / "package.json").read_bytes())["packageManager"],
    "schema": migrations[-1].parent.name,
    "prismaSchema": digest((root / "apps/api/prisma/schema.prisma").read_bytes()),
    "migrations": {path.parent.name: digest(path.read_bytes()) for path in migrations},
    "frontend": {site: {"ociManifest": images[site]["ociManifest"], "assetsEmbedded": True} for site in ("web", "admin")},
    "featureGates": {"commercialPayments": "closed", "providerRefunds": "closed", "productionPanel": "closed",
                     "deployableToProduction": False},
    "images": images,
    "priorRuntimeRehearsal": previous[0] if previous else None,
}
Path(output).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
