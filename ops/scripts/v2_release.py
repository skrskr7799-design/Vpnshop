#!/usr/bin/env python3
"""Derive image inputs and assemble the same deploy bundle consumed by vpnshop."""
import argparse
import gzip
import io
import shlex
import shutil
import subprocess
import sys
import tempfile

from release_bundle import (
    HEX, IMAGE_KEYS, NOTE_FIELDS, PLATFORM, REGISTRY, REPOSITORY, REQUIRED, ROLLBACK_PROOF, SHA, ReleaseError,
    allowed_member, atomic, checksum, demand, digest_file, hashlib, json, manifest,
    matches, os, Path, re, rollback_target, tarfile, tree_id, unpack, version,
)

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def run(args, check=True, **kwargs):
    return subprocess.run(args, check=check, text=True, **kwargs)


def git(*args):
    return run(["git", *args], cwd=ROOT, capture_output=True).stdout.strip()


def tracked(root):
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
    return sorted(item.decode() for item in output.split(b"\0") if item)


def logical_lines(path):
    pending = ""
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            if not pending and line.startswith("# syntax="):
                yield line
            continue
        pending += line.removesuffix("\\")
        if line.endswith("\\"):
            pending += " "
        else:
            yield pending
            pending = ""
    demand(not pending, "Unterminated Dockerfile input")


def fingerprints(root=ROOT, platform=PLATFORM):
    """Follow stage dependencies and every explicit host COPY in the selected graph."""
    import fnmatch

    files = tracked(root)
    results = {}
    for dockerfile, targets in [("Dockerfile", ("application", "migrator", "web", "admin", "edge")),
                                ("ops/db/Dockerfile", ("db", "backup"))]:
        stages, frontend, current = {}, "", None
        for line in logical_lines(root / dockerfile):
            if line.startswith("# syntax="):
                frontend = line
                continue
            if line.startswith("FROM "):
                source, alias = re.fullmatch(r"FROM (\S+) AS ([a-z][a-z0-9-]*)", line).groups()
                demand(source in stages or matches(r"[^\s]+@sha256:" + HEX, source),
                       "Docker bases must be named stages or digest-pinned")
                current = stages[alias] = {"instructions": [line], "sources": set(), "depends": [source] if source in stages else []}
                continue
            demand(current is not None, "Unexpected global Docker build instruction")
            current["instructions"].append(line)
            if line.startswith(("COPY ", "ADD ")):
                demand(line.startswith("COPY "), "Remote or dynamic ADD is unsupported for image reuse")
                words = shlex.split(line)[1:]
                while words and words[0].startswith("--"):
                    flag = words.pop(0)
                    if flag.startswith("--from="):
                        alias = flag.split("=", 1)[1]
                        demand(alias in stages, "Unknown cross-stage image input")
                        current["depends"].append(alias)
                        break
                    demand(flag.startswith(("--chmod=", "--chown=")), "Unknown COPY option")
                else:
                    for pattern in words[:-1]:
                        demand(matches(r"[a-zA-Z0-9_./*-]+", pattern) and not pattern.startswith(("/", ".")),
                               "Docker COPY must name a bounded tracked path")
                        selected = {path for path in files
                                    if fnmatch.fnmatchcase(path, pattern) or path.startswith(pattern.rstrip("/") + "/")}
                        demand(selected, "Docker COPY input is absent from the tracked context")
                        current["sources"].update(selected)
            elif line.startswith("RUN "):
                demand(all(mount == "type=secret,id=proxy_ca" for mount in re.findall(r"--mount=([^ ]+)", line)),
                       "Unknown RUN mount input")
            elif line.startswith("ARG "):
                demand(line == "ARG REVISION=unknown", "Untracked Docker build argument")
            demand("${REVISION}" not in line or line.startswith("LABEL "), "Revision may only label build provenance")

        def visit(stage):
            yield stage
            for parent in stages[stage]["depends"]:
                yield from visit(parent)

        for image in targets:
            target = "database" if image == "db" else image
            scope = set(visit(target))
            sources = {".dockerignore", "ops/scripts/build.sh", "ops/scripts/v2_release.py"}
            for stage in scope:
                sources.update(stages[stage]["sources"])
            tree = []
            for name in sorted(sources):
                path = root / name
                demand(path.is_file() and not path.is_symlink(), "Image context contains an unsupported source")
                tree.append([name, bool(path.stat().st_mode & 0o111), digest_file(path)])
            inputs = {"platform": platform, "target": target, "dockerfile": dockerfile, "frontend": frontend,
                      "stages": [stages[key]["instructions"] for key in stages if key in scope], "tree": tree}
            results[image] = tree_id(inputs).removeprefix("sha256:")
    demand(set(results) == set(IMAGE_KEYS), "Image plan does not cover every target")
    return results


def migration_history(root=ROOT):
    base = root / "apps/api/prisma/migrations"
    return {path.parent.name: digest_file(path) for path in sorted(base.glob("*/migration.sql"))}


def reuse(previous, current, exists, ancestor):
    return {name: item for name, item in previous.items() if name in current and item["fingerprint"] == current[name]
            and ancestor(item["source"]) and exists(name, item)}


def verify_registry(name, item):
    reference = item["reference"]
    if run(["docker", "pull", "--platform", PLATFORM, reference], check=False,
           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        return False
    inspected = json.loads(run(["docker", "image", "inspect", reference], capture_output=True).stdout)[0]
    labels = inspected["Config"]["Labels"]
    return (inspected["Os"] + "/" + inspected["Architecture"] == PLATFORM
            and labels.get("org.opencontainers.image.source") == f"https://github.com/{REPOSITORY}"
            and labels.get("org.opencontainers.image.revision") == item["source"]
            and reference in (inspected["RepoDigests"] or []))


def launcher(output):
    payload = (HERE / "vpnshop-launcher.in").read_bytes()
    for filename in ("release_bundle.py", "vpnshop_cli.py"):
        code = (HERE / filename).read_bytes()
        demand(b"\nVPNSHOP_PYTHON\n" not in code, "Invalid Python launcher input")
        payload += code + b"\n"
    atomic(output, payload + b'VPNSHOP_PYTHON\n)" "$@"\n', 0o755)


def notes_text(tag, sha, history, old_history, entries, supplied):
    required = {*NOTE_FIELDS, "coordination"}
    demand(required <= set(supplied) <= required | {"rollback_compatible_with"}
           and all(isinstance(supplied[key], str) and supplied[key].strip() for key in NOTE_FIELDS)
           and supplied["coordination"] in {"compatible", "coordinated"}, "Maintainer release notes are incomplete")
    reverse = supplied.get("rollback_compatible_with")
    if "rollback_compatible_with" in supplied:
        demand(rollback_target(reverse)[0] != tag and supplied["coordination"] == "compatible",
               "Independent rollback requires compatible coordination and an earlier release")
    previous = old_history or {}
    added = [name for name in sorted(history) if name not in previous]
    sections = {
        "Source commit": sha,
        "Changes": supplied["changes"],
        "New images": "\n".join(f"- `{name}` from `{item['source']}`" for name, item in entries.items() if item["decision"] == "built") or "None.",
        "Reused images": "\n".join(f"- `{name}` from `{item['source']}`" for name, item in entries.items() if item["decision"] == "reused") or "None.",
        "Migrations": "\n".join(f"- `{name}`" for name in added) or "Unchanged.",
        "New settings": supplied["settings"],
        "New mandatory secrets": supplied["secrets"],
        "Compatibility": supplied["compatibility"] + f"\n\nCore/Edge: {supplied['coordination']}.",
        "Update procedure": supplied["update"],
        "Downtime": supplied["downtime"],
        "Rollback": supplied["rollback"] + ("\n\nIndependent Core/Edge rollback validated to " + reverse + "."
                                             if reverse else "\n\nIndependent Core/Edge rollback is unconfirmed."),
        "Known issues": supplied["known_issues"],
    }
    return f"# VPNShop {tag}\n\n" + "\n\n".join(f"## {title}\n\n{body.strip()}" for title, body in sections.items()) + "\n"


def packaging_files():
    ops = ROOT / "ops"
    for directory in ("compose", "monitoring", "templates"):
        for path in sorted((ops / directory).iterdir()):
            relative = str(path.relative_to(ops))
            if allowed_member(relative):
                # The PASS 01 backup symlink is packaged as regular file with the canonical legacy contents.
                demand(path.is_file() and (not path.is_symlink() or relative == "compose/backup.yml"),
                       "Unexpected infrastructure symlink")
                yield relative, path.read_bytes()
    for relative in ("compose.yml", "compose.backup.yml", "scripts/preflight.py",
                     "backup/prepare-restored.sql", "db/grants.sql"):
        yield relative, (ops / relative).read_bytes()


def make_bundle(output, tag, sha, entries, history, prior_history, notes):
    version(tag)
    if prior_history:
        demand(all(history.get(name) == value for name, value in prior_history.items()), "Applied migration was removed or changed")
        demand(all(name > max(prior_history) for name in history.keys() - prior_history.keys()), "New migrations must follow existing history")
    output.mkdir(parents=True, exist_ok=True)
    script = output / "vpnshop.sh"
    launcher(script)
    values = {"VPNSHOP_VERSION": tag, "GIT_SHA": sha, **{key: entries[name]["reference"] for name, key in IMAGE_KEYS.items()},
              "MIGRATION_TREE": tree_id(history)}
    metadata = {"images": entries, "platform": PLATFORM, "coordination": notes["coordination"], "repository": REPOSITORY}
    files = dict(packaging_files()) | {
        "release.env": "".join(f"{key}={value}\n" for key, value in values.items()).encode(),
        "release-images.json": (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode(),
        "migration-history.json": (json.dumps(history, indent=2, sort_keys=True) + "\n").encode(),
        "NOTES.md": notes_text(tag, sha, history, prior_history, entries, notes).encode(),
        "vpnshop.sh": script.read_bytes(),
    }
    demand(ROLLBACK_PROOF not in files, "Rollback proof is generated from verified release metadata")
    if "rollback_compatible_with" in notes:
        files[ROLLBACK_PROOF] = (notes["rollback_compatible_with"] + "\n").encode()
    demand(REQUIRED <= files.keys(), "Missing required release files")
    archive = output / f"vpnshop-deploy-{tag}.tar.gz"
    with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as gz, \
            tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, data in sorted(files.items()):
            entry = tarfile.TarInfo(name)
            entry.mode = 0o755 if name == "vpnshop.sh" else 0o644
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
    for asset in (script, archive):
        check = asset.with_name(asset.name + ".sha256")
        atomic(check, f"{digest_file(asset)}  {asset.name}\n".encode())
        checksum(asset, check)
    with tempfile.TemporaryDirectory() as directory:
        extracted = Path(directory)
        unpack(archive, extracted)
        demand(digest_file(extracted / script.name) == digest_file(script), "Archive contains a different CLI")
    return archive


def fixture_entries(sha, image_inputs):
    return {name: {"source": sha, "fingerprint": fingerprint, "decision": "built",
                   "reference": f"{REGISTRY}/{name}@sha256:{'0' * 64}"} for name, fingerprint in image_inputs.items()}


def previous_release(tag, directory, current_sha):
    version(tag)
    asset = f"vpnshop-deploy-{tag}.tar.gz"
    run(["gh", "release", "download", tag, "--repo", REPOSITORY, "--pattern", asset, "--pattern",
         asset + ".sha256", "--dir", str(directory)])
    checksum(directory / asset, directory / (asset + ".sha256"))
    run(["gh", "attestation", "verify", str(directory / asset), "--repo", REPOSITORY,
         "--signer-workflow", f"{REPOSITORY}/.github/workflows/release-images.yml",
         "--source-ref", "refs/heads/main", "--deny-self-hosted-runners"])
    unpacked = directory / "previous"
    unpacked.mkdir()
    old, history, metadata = unpack(directory / asset, unpacked)
    demand(old["VPNSHOP_VERSION"] == tag and is_ancestor(old["GIT_SHA"], current_sha), "Prior release does not belong to the source ancestry")
    for item in metadata["images"].values():
        demand(is_ancestor(item["source"], old["GIT_SHA"]), "Prior image is outside the attested release ancestry")
    return history, metadata["images"], old["GIT_SHA"]


def is_ancestor(older, newer):
    return run(["git", "merge-base", "--is-ancestor", older, newer], cwd=ROOT, check=False).returncode == 0


def publish_image(name, sha, fingerprint):
    source = f"mzt-ci-{name}:{sha}"
    tag = f"{REGISTRY}/{name}:{sha}"
    run(["docker", "tag", source, tag])
    pushed = run(["docker", "push", tag], capture_output=True)
    candidates = re.findall(r"\bdigest: (sha256:[a-f0-9]{64})\b", pushed.stdout)
    demand(len(candidates) == 1, "Registry response did not include one digest")
    item = {"fingerprint": fingerprint, "source": sha, "decision": "built",
            "reference": f"{REGISTRY}/{name}@{candidates[0]}"}
    demand(verify_registry(name, item), "Registry image provenance could not be verified")
    expected_id = run(["docker", "image", "inspect", "--format", "{{.Id}}", source], capture_output=True).stdout
    actual_id = run(["docker", "image", "inspect", "--format", "{{.Id}}", item["reference"]], capture_output=True).stdout
    demand(expected_id == actual_id, "Registry image differs from tested image")
    return item


def production():
    sha = git("rev-parse", "HEAD")
    demand(os.environ.get("GITHUB_REF") == "refs/heads/main" and os.environ.get("GITHUB_SHA") == sha
           and os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "Registry publication requires the authorized main workflow")
    demand(not git("status", "--porcelain", "--untracked-files=all"), "Publication requires a clean build context")
    return sha


def prepare_plan(prior, output, refresh):
    sha = production()
    current = fingerprints()
    old_history, old_images = {}, {}
    old_sha = None
    if prior != "first-release":
        with tempfile.TemporaryDirectory() as directory:
            old_history, old_images, old_sha = previous_release(prior, Path(directory), sha)
    selected = {} if refresh else reuse(old_images, current, verify_registry, lambda source: is_ancestor(source, sha))
    for name, item in selected.items():
        run(["docker", "tag", item["reference"], f"mzt-ci-{name}:{sha}"])
    changed = sorted(current.keys() - selected.keys())
    if changed:
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / "source"
            git("worktree", "add", "--detach", str(context), sha)
            try:
                run(["bash", "ops/scripts/build.sh", "mzt-ci", *changed], cwd=context,
                    env=os.environ | {"MZT_BUILD_PLATFORM": PLATFORM})
            finally:
                git("worktree", "remove", "--force", str(context))
    content = {"source": sha, "current": current, "reused": selected, "prior_history": old_history,
               "prior_source": f"{prior} {old_sha}" if old_sha else None}
    atomic(output, json.dumps(content).encode())
    print("Built:", ", ".join(changed) or "none")
    print("Reused:", ", ".join(sorted(selected)) or "none")


def finalize(plan_path, tag, notes_path, output):
    sha = production()
    plan = json.loads(plan_path.read_text())
    demand(plan["source"] == sha and plan["current"] == fingerprints(), "Release inputs changed after candidate tests")
    history = migration_history()
    notes = json.loads(notes_path.read_text())
    notes_text(tag, sha, history, plan["prior_history"], {}, notes)
    demand("rollback_compatible_with" not in notes or notes["rollback_compatible_with"] == plan["prior_source"],
           "Independent rollback proof must name the exact attested predecessor")
    demand(all(history.get(name) == digest for name, digest in plan["prior_history"].items()), "Published migration history was changed")
    for name, fingerprint in plan["current"].items():
        reused = plan["reused"].get(name)
        if reused:
            demand(verify_registry(name, reused), "Previously verified registry digest is no longer available")
    entries = {name: plan["reused"][name] | {"decision": "reused"} if name in plan["reused"]
               else publish_image(name, sha, fingerprint) for name, fingerprint in plan["current"].items()}
    make_bundle(output, tag, sha, entries, history, plan["prior_history"], notes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("fingerprints")
    app = commands.add_parser("launcher")
    app.add_argument("output", type=Path)
    app = commands.add_parser("candidate")
    app.add_argument("output", type=Path)
    app = commands.add_parser("plan")
    app.add_argument("previous")
    app.add_argument("output", type=Path)
    app.add_argument("--refresh", action="store_true")
    app = commands.add_parser("finalize")
    app.add_argument("plan", type=Path)
    app.add_argument("version", type=version)
    app.add_argument("notes", type=Path)
    app.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "fingerprints":
        print(json.dumps(fingerprints(), indent=2))
    elif args.command == "launcher":
        launcher(args.output)
    elif args.command == "candidate":
        sha = git("rev-parse", "HEAD")
        notes = dict.fromkeys(NOTE_FIELDS, "Synthetic CI artifact for release-format verification.")
        notes["coordination"] = "compatible"
        make_bundle(args.output, "v0.0.0", sha, fixture_entries(sha, fingerprints()), migration_history(), None, notes)
    elif args.command == "plan":
        prepare_plan(args.previous, args.output, args.refresh)
    else:
        finalize(args.plan, args.version, args.notes, args.output)


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, subprocess.CalledProcessError, OSError, ValueError, KeyError, TypeError):
        sys.exit("VPNShop release preparation failed. Check the source, previous release and registry verification.")
