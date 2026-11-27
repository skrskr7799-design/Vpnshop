#!/usr/bin/env python3
import contextlib
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

import release_bundle as bundle
import v2_publish
import v2_release as release
import vpnshop_cli as cli


class ReleaseFixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.storage = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.storage.cleanup)
        cls.root = Path(cls.storage.name)
        cls.sha = "a" * 40
        cls.history = {"20261101000000_initial": "a" * 64}
        cls.notes = dict.fromkeys(bundle.NOTE_FIELDS, "Isolated release fixture.")
        cls.notes["coordination"] = "compatible"
        cls.entries = release.fixture_entries(cls.sha, release.fingerprints())
        cls.first = release.make_bundle(cls.root / "first", "v2.0.0", cls.sha, cls.entries, cls.history, None, cls.notes)

    def candidate(self, version="v2.1.0", names=("web",), migrations=None):
        tag = version + "-" + "-".join(names) + ("-new-schema" if migrations else "")
        folder = self.root / tag
        if not folder.exists():
            entries = {key: value.copy() for key, value in self.entries.items()}
            for name in names:
                entries[name]["reference"] = entries[name]["reference"].replace("0" * 64, "1" * 64)
            return release.make_bundle(folder, version, self.sha, entries, migrations or self.history, self.history, self.notes)
        return folder / f"vpnshop-deploy-{version}.tar.gz"


class ReleaseTests(ReleaseFixtures):
    def test_release_build_context_preserves_runtime_readability_under_private_umask(self):
        sha = release.git("rev-parse", "HEAD")
        run = release.run
        contexts = []

        def check_build(args, **kwargs):
            if args[0] != "bash":
                return run(args, **kwargs)
            context = kwargs["cwd"]
            contexts.append(context)
            self.assertEqual(args, ["bash", "ops/scripts/build.sh", "mzt-ci", "migrator"])
            self.assertEqual(stat.S_IMODE(context.parent.stat().st_mode), 0o700)
            for path, mode in (("pnpm-workspace.yaml", 0o644), ("apps/api/prisma/schema.prisma", 0o644),
                               ("apps/api/prisma", 0o755), ("ops/scripts/build.sh", 0o755)):
                self.assertEqual(stat.S_IMODE((context / path).stat().st_mode), mode, path)
            private = context.parent / "runner-output"
            private.touch()
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)

        previous = os.umask(0o077)
        try:
            with patch.object(release, "run", side_effect=check_build):
                release.build_images(sha, ["migrator"])
        finally:
            os.umask(previous)
        self.assertEqual(len(contexts), 1)
        self.assertFalse(contexts[0].exists())

    def test_build_graph_invalidates_only_relevant_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in set(release.tracked(release.ROOT)) | {"ops/scripts/v2_release.py"}:
                src, dst = release.ROOT / name, root / name
                if src.is_file() and not src.is_symlink():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
            subprocess.run(["git", "init", "-q", root], check=True)
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            original = release.fingerprints(root)
            cases = {
                "apps/web/src/styles/global.css": {"web"},
                "apps/admin/src/styles/global.css": {"admin"},
                "apps/api/src/server.ts": {"application"},
                "apps/api/prisma/schema.prisma": {"application", "migrator"},
                "apps/api/prisma/migrations/20261121000000_baseline/migration.sql": {"application", "migrator"},
                "packages/ui/src/style.css": {"web", "admin"},
                "packages/shared/src/index.ts": {"application", "admin", "web"},
                "pnpm-lock.yaml": {"application", "admin", "web", "migrator"},
                "ops/db/grants.sql": {"migrator"},
                "ops/backup/logical.sh": {"backup"},
                "ops/build/bookworm.sources": {"db", "backup"},
                "ops/build/trixie.sources": {"application", "migrator", "web", "admin"},
                "ops/build/apt-install.sh": set(bundle.IMAGE_KEYS) - {"edge"},
                "docs/V2_MASTER_SPEC.md": set(),
                ".dockerignore": set(bundle.IMAGE_KEYS),
            }
            for name, affected in cases.items():
                with self.subTest(name=name):
                    path = root / name
                    old = path.read_bytes()
                    path.write_bytes(old + b"\n")
                    try:
                        observed = release.fingerprints(root)
                        self.assertEqual({key for key, value in observed.items() if original[key] != value}, affected)
                        previous = release.fixture_entries(self.sha, original)
                        reused = release.reuse(previous, observed, lambda *_: True, lambda _: True)
                        self.assertEqual(set(reused), set(bundle.IMAGE_KEYS) - affected)
                    finally:
                        path.write_bytes(old)
            db_file = root / "ops/db/Dockerfile"
            original_db_file = db_file.read_text()
            db_file.write_text(original_db_file.replace("837bed", "347bed", 1))
            self.assertEqual({key for key, value in release.fingerprints(root).items() if original[key] != value},
                             {"db", "backup"})
            db_file.write_text(original_db_file)
            self.assertTrue(all(original[key] != value for key, value in release.fingerprints(root, "linux/arm64").items()))

    def test_safe_reuse_and_registry_failure(self):
        fingerprints = {key: value["fingerprint"] for key, value in self.entries.items()}
        self.assertFalse(release.reuse({}, fingerprints, Mock(), Mock()))
        self.assertEqual(len(release.reuse(self.entries, fingerprints, lambda *_: True, lambda _: True)), 7)
        fingerprints["migrator"] = "2" * 64
        selected = release.reuse(self.entries, fingerprints, lambda name, _: name != "db", lambda _: True)
        self.assertEqual(set(selected), set(bundle.IMAGE_KEYS) - {"db", "migrator"})
        self.assertFalse(release.reuse(self.entries, fingerprints, lambda *_: True, lambda _: False))

    def test_archive_reproducibility_and_no_source(self):
        dest = self.root / "repeat"
        again = release.make_bundle(dest, "v2.0.0", self.sha, self.entries, self.history, None, self.notes)
        self.assertEqual(self.first.read_bytes(), again.read_bytes())
        for file in (again, dest / "vpnshop.sh"):
            bundle.checksum(file, file.with_name(file.name + ".sha256"))
        with tarfile.open(again) as archive:
            members = archive.getmembers()
            self.assertTrue(all(bundle.allowed_member(m.name) and m.isfile() and m.mtime == 0 and m.uid == 0 for m in members))
            self.assertFalse(any(m.name.startswith(("apps/", "packages/", ".git/")) for m in members))
        subprocess.run(["bash", "-n", dest / "vpnshop.sh"], check=True)
        self.assertIn(b"vpnshop CLI 2", subprocess.check_output([dest / "vpnshop.sh", "version"]))
        self.assertIn(b"install", subprocess.check_output([dest / "vpnshop.sh", "help"]))

    def test_rollback_proof_is_optional_and_bound_to_an_exact_commit(self):
        predecessor = ("v2.0.0", "b" * 40)
        notes = self.notes | {"rollback_compatible_with": " ".join(predecessor)}
        archive = release.make_bundle(self.root / "rollback-proof", "v2.1.0",
                                      self.sha, self.entries, self.history, self.history, notes)
        dest = self.root / "rollback-unpacked"
        dest.mkdir()
        self.assertEqual(bundle.unpack(archive, dest)[2]["rollbackCompatibleWith"], predecessor)
        with self.assertRaisesRegex(bundle.ReleaseError, "compatible coordination"):
            release.notes_text("v2.1.0", self.sha, self.history, self.history, self.entries,
                               notes | {"coordination": "coordinated"})

    def test_reject_archive_invalid_paths_links_and_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, path_type in [("../vpnshop.sh", tarfile.REGTYPE), ("/etc/vpnshop.sh", tarfile.REGTYPE),
                                    ("vpnshop.sh", tarfile.SYMTYPE), ("vpnshop.sh", tarfile.LNKTYPE),
                                    ("vpnshop.sh", tarfile.FIFOTYPE), ("apps/api/src/file", tarfile.REGTYPE)]:
                with self.subTest(name=name, path_type=path_type):
                    archive = root / "bad.tar.gz"
                    item = tarfile.TarInfo(name)
                    item.type = path_type
                    item.linkname = "../config"
                    with tarfile.open(archive, "w:gz") as tar:
                        tar.addfile(item)
                    with self.assertRaises(bundle.ReleaseError):
                        bundle.unpack(archive, root)
            with tarfile.open(root / "bad.tar.gz", "w:gz") as tar:
                tar.addfile(tarfile.TarInfo("vpnshop.sh"))
                tar.addfile(tarfile.TarInfo("vpnshop.sh"))
            with self.assertRaises(bundle.ReleaseError):
                bundle.unpack(root / "bad.tar.gz", root)

    def test_manifest_and_checksum_refuse_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle.unpack(self.first, root)
            env = root / "release.env"
            env.write_text(env.read_text().replace("@sha256:", ":latest#"))
            with self.assertRaises(bundle.ReleaseError):
                bundle.manifest(root)
            proof = root / "bad.sha256"
            proof.write_text("f" * 64 + f"  {self.first.name}\n")
            with self.assertRaises(bundle.ReleaseError):
                bundle.checksum(self.first, proof)
            with self.assertRaises(bundle.ReleaseError):
                release.make_bundle(root, "v2.0.0", self.sha, self.entries, {}, self.history, self.notes)

    def test_existing_release_and_ambiguous_provider_are_rejected(self):
        for code, response, outcome in [(1, "HTTP/2.0 404 Not Found\n", True),
                                        (0, "HTTP/2.0 200 OK\n", False),
                                        (1, "HTTP/2.0 403 Forbidden\n", False),
                                        (1, "", False)]:
            with patch.object(v2_publish, "run", return_value=Mock(returncode=code, stdout=response)):
                if outcome:
                    v2_publish.require_absent("fixture")
                else:
                    with self.assertRaises(bundle.ReleaseError):
                        v2_publish.require_absent("fixture")

    def test_release_tag_must_point_at_the_tested_commit(self):
        with patch.object(v2_publish, "run", return_value=Mock(stdout="b" * 40)):
            with self.assertRaisesRegex(bundle.ReleaseError, "candidate commit"):
                v2_publish.tag_commit("v2.0.0", self.sha)
        with patch.object(v2_publish, "run", return_value=Mock(stdout=self.sha)) as run:
            v2_publish.tag_commit("v2.0.0", self.sha, create=True)
            self.assertIn("POST", run.call_args_list[0].args[0])
            self.assertIn("sha=" + self.sha, run.call_args_list[0].args[0])


class LocalSource:
    def __init__(self, archive):
        self.archive = archive

    def fetch(self, selection, directory, **kwargs):
        tag = self.archive.name.removeprefix("vpnshop-deploy-").removesuffix(".tar.gz")
        bundle.demand(tag == selection or selection == "latest", "Unknown fixture release")
        copied = directory / self.archive.name
        shutil.copyfile(self.archive, copied)
        return tag, copied


class VirtualRuntime:
    deployed = None
    history_in_db = {}
    events = []
    failing = False
    missing = False

    def __init__(self, deployment, release_path, **kwargs):
        self.deployment, self.release = deployment, release_path
        self.values, self.history, self.metadata = bundle.manifest(release_path)
        self.flags = set()
        if release_path.name == "release" and self.missing:
            raise bundle.ReleaseError("Missing required setting")

    def containers(self):
        return {"db": {"State": "running"}}

    def ensure_images(self):
        self.events.append(("pull", self.values["VPNSHOP_VERSION"]))

    def validate_owners(self):
        self.events.append(("preflight", self.values["VPNSHOP_VERSION"]))

    def check_owners_read_only(self):
        return "OK"

    def logical_service(self):
        return "logical-local"

    def inventory(self):
        return type(self).history_in_db, 1, 170012

    def start(self, *services):
        self.events.append(("start", self.values["VPNSHOP_VERSION"], services))

    def stop_writers(self):
        self.events.append(("drain", self.values["VPNSHOP_VERSION"]))

    def quarantine_restore(self):
        self.events.append(("quarantine", self.values["VPNSHOP_VERSION"]))

    def migrate(self):
        cli.migration_delta(self.history_in_db, self.history)
        type(self).history_in_db = self.history
        self.events.append(("migrate", self.values["VPNSHOP_VERSION"]))

    def verify_live(self):
        if self.failing:
            raise bundle.ReleaseError("Injected readiness failure")


class CLITests(ReleaseFixtures):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.deploy = cli.Deployment(self.folder / "install", self.folder / "vpnshop")
        self.output = io.StringIO()
        capture = contextlib.redirect_stdout(self.output)
        capture.__enter__()
        self.addCleanup(capture.__exit__, None, None, None)
        fake_docker = Mock(stdout=b"", returncode=0)
        shim = patch.object(cli, "call", return_value=fake_docker)
        self.call = shim.start()
        self.addCleanup(shim.stop)
        # Loaded preflight modules are release-specific, so substitute only the ownership probe in fixtures.
        api = cli.module(release.ROOT / "ops/scripts/preflight.py")
        api.host_ownership = lambda *args: lambda _uid: f"{os.geteuid()}:{os.getegid()}"
        module_fixture = patch.object(cli, "module", return_value=api)
        module_fixture.start()
        self.addCleanup(module_fixture.stop)
        VirtualRuntime.events, VirtualRuntime.history_in_db = [], self.history.copy()
        VirtualRuntime.failing = VirtualRuntime.missing = False
        self.runtime = patch.object(cli, "Runtime", VirtualRuntime)
        self.runtime.start()
        self.addCleanup(self.runtime.stop)
        space = patch.object(cli.shutil, "disk_usage", return_value=Mock(free=10 * 1024 * 1024 * 1024))
        space.start()
        self.addCleanup(space.stop)

    def install(self, role):
        self.deploy.install("v2.0.0", role, LocalSource(self.first))
        return self.deploy.pointer("current")

    def update(self, archive, *extra):
        args = cli.parser().parse_args(["update", archive.name.removeprefix("vpnshop-deploy-").removesuffix(".tar.gz"), *extra])
        self.deploy.update(args, LocalSource(archive))

    def test_install_all_roles_and_repeat_preserves_state(self):
        for role in ("single", "core", "edge"):
            with self.subTest(role=role):
                self.deploy = cli.Deployment(self.folder / role, self.folder / f"vpnshop-{role}")
                self.install(role)
                self.assertEqual(self.deploy.role, role)
                if role == "edge":
                    self.assertEqual(list(self.deploy.secrets.iterdir()), [])
                else:
                    self.assertTrue((self.deploy.secrets / "backup_url").is_file())
                    self.assertNotEqual((self.deploy.secrets / "web_cookie").read_bytes(), (self.deploy.secrets / "web_jwt").read_bytes())
                    configure = (self.deploy.secrets / "public_url").read_text()
                    self.assertIn((self.deploy.secrets / "db_public").read_text().strip(), configure)
                config = self.deploy.config.read_bytes()
                with self.assertRaises(bundle.ReleaseError):
                    self.install(role)
                self.assertEqual(config, self.deploy.config.read_bytes())
        self.assertFalse(any("up" in call.args[0] or "run" in call.args[0] for call in self.call.call_args_list))

    def test_dry_run_does_not_switch_or_pull(self):
        current = self.install("edge")
        self.update(self.candidate(), "--dry-run", "--yes")
        self.assertEqual(current, self.deploy.pointer("current"))
        self.assertEqual(VirtualRuntime.events, [])
        self.assertIsNone(self.deploy.read_pending())

    def test_dry_run_rejects_missing_configuration_and_space(self):
        self.install("edge")
        VirtualRuntime.missing = True
        with self.assertRaisesRegex(bundle.ReleaseError, "Missing"):
            self.update(self.candidate(), "--dry-run")
        VirtualRuntime.missing = False
        with patch.object(cli.shutil, "disk_usage", return_value=Mock(free=0)):
            with self.assertRaisesRegex(bundle.ReleaseError, "free space"):
                self.update(self.candidate(), "--dry-run")

    def test_update_one_frontend_and_rollback_without_db_restart(self):
        current = self.install("single")
        secrets_before = {path.name: path.read_bytes() for path in self.deploy.secrets.iterdir()}
        config = self.deploy.config.read_bytes()
        resources = self.deploy.config.with_name("resources.env")
        resources.write_text("RESOURCE_PROFILE=micro\n")
        self.update(self.candidate(), "--yes")
        self.assertEqual(self.deploy.pointer("current").name, "v2.1.0")
        self.assertEqual(self.deploy.pointer("previous"), current)
        self.assertFalse(any(event[0] in ("drain", "migrate") or event[0] == "start" and event[2]
                             for event in VirtualRuntime.events))
        self.deploy.rollback(cli.parser().parse_args(["rollback", "--yes"]))
        self.assertEqual(self.deploy.pointer("current"), current)
        self.assertEqual(secrets_before, {path.name: path.read_bytes() for path in self.deploy.secrets.iterdir()})
        self.assertEqual(config, self.deploy.config.read_bytes())
        self.assertEqual(resources.read_text(), "RESOURCE_PROFILE=micro\n")

    def test_failed_healthcheck_retains_pending_and_resume_only_target(self):
        self.install("edge")
        VirtualRuntime.failing = True
        with self.assertRaisesRegex(bundle.ReleaseError, "readiness"):
            self.update(self.candidate(names=("application",)), "--yes")
        pending = self.deploy.read_pending()
        self.assertEqual(pending["phase"], "starting")
        args = cli.parser().parse_args(["up"])
        with self.assertRaisesRegex(bundle.ReleaseError, "interrupted"):
            cli.execute(args, self.deploy)
        VirtualRuntime.failing = False
        self.deploy.recover(cli.parser().parse_args(["recover", "--yes"]))
        self.assertIsNone(self.deploy.read_pending())
        self.assertEqual(self.deploy.pointer("previous").name, "v2.0.0")

    def test_migration_update_with_backup_and_refused_rollback(self):
        self.install("single")
        new_history = self.history | {"20261102000000_next": "b" * 64}
        archive = self.candidate(names=("application", "migrator"), migrations=new_history)
        with patch.object(cli, "ask") as confirm, patch.object(self.deploy, "backup", return_value="fixture") as backup, \
                patch.object(self.deploy, "backup_record"):
            self.update(archive, "--yes")
        self.assertEqual(confirm.call_args_list[-1].kwargs["phrase"], "v2.1.0")
        self.assertTrue(backup.called)
        self.assertEqual(VirtualRuntime.history_in_db, new_history)
        self.assertIn(("migrate", "v2.1.0"), VirtualRuntime.events)
        with self.assertRaisesRegex(bundle.ReleaseError, "incompatible"):
            self.deploy.rollback(cli.parser().parse_args(["rollback", "--yes"]))

    def test_restore_recovery_stays_in_review_until_exact_confirmation(self):
        installed = self.install("single")
        restore_id = "mzt_restore_abcdef123456"
        pending = {"operation": "restore", "source": installed.name, "target": installed.name,
                   "oldOid": "100", "newOid": "101", "scratch": restore_id,
                   "retained": "mzt_retained_abcdef123456", "backup": "fixture", "safetyBackup": "safety"}
        self.deploy.set_pending(pending, "swap-prepared")
        recover = cli.parser().parse_args(["recover"])

        def oid(query, database):
            self.assertEqual(database, "postgres")
            return pending["oldOid"] if "NOT datallowconn" in query else pending["newOid"]

        with patch.object(VirtualRuntime, "sql", side_effect=oid, create=True), \
                patch.object(self.deploy, "backup_record"), patch.object(cli, "ask") as confirm:
            self.deploy.recover(recover)
            self.deploy.recover(recover)
            self.assertEqual(self.deploy.read_pending()["phase"], cli.RESTORE_REVIEW)
            self.assertFalse(any(event[0] == "start" for event in VirtualRuntime.events))
            for args in (["up"], ["restart"], ["update", "latest"], ["rollback"], ["restore", "fixture"]):
                with self.assertRaisesRegex(bundle.ReleaseError, "awaiting reconciliation"):
                    cli.execute(cli.parser().parse_args(args), self.deploy)
            with self.assertRaisesRegex(bundle.ReleaseError, "Confirmation ID"):
                self.deploy.finish_restore("wrong-id")
            VirtualRuntime.failing = True
            with self.assertRaisesRegex(bundle.ReleaseError, "readiness"):
                self.deploy.finish_restore(restore_id)
            self.assertEqual(self.deploy.read_pending()["phase"], cli.RESTORE_REVIEW)
            self.assertEqual(VirtualRuntime.events[-1][0], "quarantine")
            VirtualRuntime.failing = False
            self.deploy.finish_restore(restore_id)
            self.assertEqual(confirm.call_args.kwargs, {"phrase": restore_id})
            self.assertIsNone(self.deploy.read_pending())

    def test_split_rollback_requires_explicit_order_unless_reverse_pair_is_proven(self):
        current = self.install("edge")
        target = self.deploy.releases / "v2.1.0"
        target.mkdir()
        bundle.unpack(self.candidate(), target)
        new_sha = "b" * 40
        real_manifest = bundle.manifest

        def metadata(path):
            values, history, images = real_manifest(path)
            if path == target:
                return values | {"GIT_SHA": new_sha}, history, images | source_metadata
            return values, history, images | target_metadata

        with patch.object(bundle, "manifest", side_effect=metadata):
            for source, destination, proof in [
                ("compatible", "coordinated", self.sha),
                ("coordinated", "compatible", self.sha),
                ("coordinated", "coordinated", self.sha),
                ("compatible", "compatible", None),
                ("compatible", "compatible", "c" * 40),
                ("compatible", "compatible", self.sha),
            ]:
                with self.subTest(source=source, destination=destination, proof=proof), patch.object(cli, "ask") as confirm:
                    source_metadata = {"coordination": source, "rollbackCompatibleWith": ("v2.0.0", proof) if proof else None}
                    target_metadata = {"coordination": destination}
                    self.deploy.switch("current", target)
                    self.deploy.switch("previous", current)
                    independent = source == destination == "compatible" and proof == self.sha
                    if not independent:
                        with self.assertRaisesRegex(bundle.ReleaseError, "--order"):
                            self.deploy.rollback(cli.parser().parse_args(["rollback", "--yes"]))
                        self.assertEqual(self.deploy.pointer("current"), target)
                    args = ["rollback", "--yes"] if independent else ["rollback", "--yes", "--order", "edge-first"]
                    self.deploy.rollback(cli.parser().parse_args(args))
                    self.assertEqual(self.deploy.pointer("current"), current)
                    self.assertEqual(confirm.call_count, 1 if independent else 2)
                    if not independent:
                        self.assertEqual(confirm.call_args_list[0].kwargs, {"phrase": "v2.0.0 edge-first"})

    def test_admin_local_command_refuses_edge(self):
        self.install("edge")
        args = cli.parser().parse_args(["admin", "bootstrap", "--username", "example", "--password-stdin"])
        with self.assertRaisesRegex(bundle.ReleaseError, "Single and Core"):
            cli.execute(args, self.deploy)

    def test_lock_and_cleanup_protect_recovery_paths(self):
        self.install("edge")
        with self.deploy.lock(), self.assertRaisesRegex(bundle.ReleaseError, "holds"):
            with self.deploy.lock():
                pass
        former = self.deploy.pointer("current")
        for version in ("v1.0.0", "v1.1.0", "v1.2.0", "v2.1.0", "v2.2.0", "v2.3.0"):
            (self.deploy.releases / version).mkdir()
        self.deploy.set_pending({"operation": "update", "source": "v2.0.0", "target": "v1.0.0"}, "prepared")
        self.deploy.prune()
        self.assertTrue(former.is_dir())
        self.assertTrue((self.deploy.releases / "v1.0.0").is_dir())
        self.assertFalse((self.deploy.releases / "v1.1.0").exists())

    def test_corrupt_release_failed_download_and_cli_options(self):
        self.install("edge")
        with patch.object(LocalSource, "fetch", side_effect=bundle.ReleaseError("offline")):
            with self.assertRaisesRegex(bundle.ReleaseError, "offline"):
                self.update(self.candidate(), "--yes")
        with self.assertRaises(SystemExit):
            cli.parser().parse_args(["install", "latest", "--role", "legacy"])
        with self.assertRaises(bundle.ReleaseError):
            bundle.version("../../v2.0.0")
        args = cli.parser().parse_args(["compose", "down", "-v"])
        with self.assertRaisesRegex(bundle.ReleaseError, "lifecycle"):
            cli.execute(args, self.deploy)

    def test_migration_history_rejects_reordering_tampering(self):
        with self.assertRaises(bundle.ReleaseError):
            cli.migration_delta({"20261103000000_unknown": "a" * 64}, self.history)
        with self.assertRaises(bundle.ReleaseError):
            cli.migration_delta({next(iter(self.history)): "b" * 64}, self.history)
        self.assertEqual(cli.migration_delta(self.history, self.history), [])


if __name__ == "__main__":
    unittest.main()
