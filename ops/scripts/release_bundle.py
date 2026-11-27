"""Shared release artifact format and a bounded archive reader for the installer."""
import gzip
import hashlib
import io
import json
import os
import re
import stat
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

REPOSITORY = "skrskr7799-design/Vpnshop"
REGISTRY = "ghcr.io/" + REPOSITORY.lower()
IMAGE_KEYS = dict(application="APPLICATION_IMAGE", migrator="MIGRATOR_IMAGE", db="DATABASE_IMAGE",
                  backup="BACKUP_IMAGE", web="WEB_IMAGE", admin="ADMIN_IMAGE", edge="EDGE_IMAGE")
PLATFORM = "linux/amd64"
VERSION = r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
SHA = r"[0-9a-f]{40}"
HEX = r"[0-9a-f]{64}"
MAX_BUNDLE = 20 * 1024 * 1024
REQUIRED = {"release.env", "release-images.json", "migration-history.json", "NOTES.md", "vpnshop.sh",
            "scripts/preflight.py", "templates/secrets.list", "compose/core.yml", "compose/edge.yml",
            "compose/admin.yml", "compose/mode.single.yml", "compose/mode.core.yml", "compose/mode.edge.yml",
            "compose.yml", "compose.backup.yml", "backup/prepare-restored.sql", "db/grants.sql",
            "templates/env.single.example", "templates/env.core.example", "templates/env.edge.example",
            "compose/link.private.yml", "compose/link.public.yml", "compose/link.edge.private.yml",
            "compose/link.edge.public.yml", "compose/link.edge.ca.yml", "compose/backup.local.yml",
            "compose/backup.yml", "compose/mail.yml", "compose/oauth.yml", "compose/egress.yml",
            "compose/oauth.google.yml", "compose/oauth.telegram.yml", "compose/egress.panel-key.yml",
            "monitoring/prometheus.yml", "monitoring/alerts.yml", "monitoring/alertmanager.yml", "monitoring/sink.mjs"}
NOTE_FIELDS = ("changes", "settings", "secrets", "compatibility", "update", "downtime", "rollback", "known_issues")
ROLLBACK_PROOF = "templates/rollback-compatibility.list"


def rollback_target(value):
    demand(matches(VERSION + " " + SHA, value) and len(value) <= 86,
           "Independent rollback requires an exact predecessor version and SHA")
    return tuple(value.split(" "))


class ReleaseError(Exception):
    pass


def demand(condition, message):
    if not condition:
        raise ReleaseError(message)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def version(value):
    demand(matches(VERSION, value) and len(value) <= 45, "Expected latest or a release version such as v2.0.0")
    return value


def digest_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def tree_id(history):
    data = json.dumps(history, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(data).hexdigest()


def manifest(directory):
    values = {}
    for line in (directory / "release.env").read_text().splitlines():
        name, sep, value = line.partition("=")
        demand(sep and name not in values, "Invalid or duplicate manifest field")
        values[name] = value
    demand(set(values) == {"VPNSHOP_VERSION", "GIT_SHA", "MIGRATION_TREE", *IMAGE_KEYS.values()},
           "Unexpected or missing release manifest fields")
    version(values["VPNSHOP_VERSION"])
    demand(matches(SHA, values["GIT_SHA"]), "Invalid release commit")
    for image, key in IMAGE_KEYS.items():
        demand(matches(re.escape(f"{REGISTRY}/{image}@sha256:") + HEX, values[key]), "Untrusted or mutable image reference")
    history = json.loads((directory / "migration-history.json").read_text())
    demand(isinstance(history, dict) and bool(history)
           and all(matches(r"[0-9]{14}_[a-z0-9_]+", key) and matches(HEX, item) for key, item in history.items())
           and values["MIGRATION_TREE"] == tree_id(history), "Invalid migration history")
    provenance = json.loads((directory / "release-images.json").read_text())
    demand(set(provenance) == {"images", "platform", "coordination", "repository"}
           and provenance["repository"] == REPOSITORY and provenance["platform"] == PLATFORM
           and provenance["coordination"] in {"compatible", "coordinated"}
           and set(provenance["images"]) == set(IMAGE_KEYS), "Invalid release image metadata")
    for image, item in provenance["images"].items():
        demand(set(item) == {"fingerprint", "source", "reference", "decision"} and matches(HEX, item["fingerprint"])
               and matches(SHA, item["source"]) and item["reference"] == values[IMAGE_KEYS[image]]
               and item["decision"] in {"built", "reused"}
               and (item["decision"] != "built" or item["source"] == values["GIT_SHA"]), "Invalid image provenance")
    proof = directory / ROLLBACK_PROOF
    if proof.is_file():
        predecessor = rollback_target(proof.read_text(encoding="ascii").removesuffix("\n"))
        demand(predecessor[0] != values["VPNSHOP_VERSION"]
               and provenance["coordination"] == "compatible", "Invalid independent rollback compatibility proof")
        provenance["rollbackCompatibleWith"] = predecessor
    return values, history, provenance


def allowed_member(name):
    p = PurePosixPath(name)
    if p.as_posix() != name or p.is_absolute() or ".." in p.parts:
        return False
    if name in REQUIRED:
        return True
    if len(p.parts) != 2 or not matches(r"[A-Za-z0-9][A-Za-z0-9_.-]*", p.name):
        return False
    suffixes = {"compose": (".yml",), "monitoring": (".yml", ".mjs"),
                "templates": (".example", ".list")}
    return p.parts[0] in suffixes and p.name.endswith(suffixes[p.parts[0]])


def checksum(asset, checksum_path):
    expected = checksum_path.read_text(encoding="ascii").strip()
    demand(matches(HEX + r"  " + re.escape(asset.name), expected) and expected.split()[0] == digest_file(asset),
           "Release asset checksum mismatch")


def unpack(archive, destination):
    demand(archive.stat().st_size <= MAX_BUNDLE, "Release archive is too large")
    seen = set()
    total = 0
    with gzip.open(archive, "rb") as compressed:
        expanded = compressed.read(MAX_BUNDLE + 1)
    demand(len(expanded) <= MAX_BUNDLE, "Release archive expands beyond the configured size limit")
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as tar:
        for member in tar:
            total += member.size
            demand(total <= MAX_BUNDLE and len(seen) < 128 and member.type == tarfile.REGTYPE and not member.pax_headers
                   and allowed_member(member.name) and member.name not in seen, "Unexpected or unsafe archive member")
            seen.add(member.name)
            output = destination / member.name
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with output.open("xb") as stream:
                stream.write(tar.extractfile(member).read())
            output.chmod(0o755 if output.name == "vpnshop.sh" else 0o644)
    demand(REQUIRED <= seen, "Deploy archive is incomplete")
    return manifest(destination)


def atomic(path, content, mode=0o600):
    fd, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        sync_directory(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_regular(path):
    info = path.lstat()
    demand(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
           "Credential file must be private, regular and owned by the operator")
    return path.read_text().strip()
