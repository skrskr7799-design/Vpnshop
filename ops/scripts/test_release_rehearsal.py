#!/usr/bin/env python3
"""Exercise production release code with an isolated registry/GitHub command contract."""
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import release_bundle as bundle
import v2_publish
import v2_release as release


class ReleaseRehearsal(unittest.TestCase):
    sha = "a" * 40
    tag = "v2.0.0"

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "bundle"
        self.plan = self.root / "plan.json"
        self.notes = self.root / "notes.json"
        self.notes.write_text(json.dumps(dict.fromkeys(bundle.NOTE_FIELDS, "Release rehearsal.") |
                                         {"coordination": "compatible"}))
        self.images = {}
        self.assets = {}
        self.tag_sha = None
        self.draft = None
        self.pushes = []
        self.fail = None
        for module, attribute, value in (
            (release, "production", self.sha), (v2_publish, "production", self.sha),
        ):
            mocked = patch.object(module, attribute, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)
        for module in (release, v2_publish):
            mocked = patch.object(module, "run", side_effect=self.transport)
            mocked.start()
            self.addCleanup(mocked.stop)
        env = patch.dict(release.os.environ, {"GITHUB_RUN_ID": "1847", "GITHUB_RUN_ATTEMPT": "1"})
        env.start()
        self.addCleanup(env.stop)

    def transport(self, args, *, check=True, **kwargs):
        def result(stdout="", code=0):
            if code and check:
                raise subprocess.CalledProcessError(code, args)
            return subprocess.CompletedProcess(args, code, stdout, "")

        if args[:2] == ["docker", "tag"]:
            self.assertTrue(args[-1].endswith(f":{self.sha}-1847-1"))
            package = args[-1].rsplit(":", 1)[0]
            self.assertTrue(package.startswith(bundle.REGISTRY + "/"))
            self.images[args[-1]] = args[2]
            return result()
        if args[:2] == ["docker", "push"]:
            self.pushes.append(args[-1])
            if self.fail == "registry-denied":
                return result(code=1)
            package = args[-1].rsplit(":", 1)[0]
            digest = "sha256:" + hashlib.sha256(package.encode()).hexdigest()
            self.images[f"{package}@{digest}"] = self.images[args[-1]]
            return result("digest: " + digest)
        if args[:2] == ["docker", "pull"]:
            return result(code=int(args[-1] not in self.images))
        if args[:3] == ["docker", "image", "inspect"]:
            if "--format" in args:
                return result("different-image" if self.fail == "registry-mismatch" and "@" in args[-1]
                              else self.images.get(args[-1], args[-1]))
            return result(json.dumps([{"Os": "linux", "Architecture": "amd64", "RepoDigests": [args[-1]],
                "Config": {"Labels": {"org.opencontainers.image.source": f"https://github.com/{bundle.REPOSITORY}",
                                      "org.opencontainers.image.revision": self.sha}}}]))
        if args[:2] == ["docker", "run"]:
            self.assertIn("--redact=100", args)
            folder = Path(next(arg.removesuffix(":/report") for arg in args if arg.endswith(":/report")))
            self.assertTrue(folder.is_dir())
            if self.fail == "scanner-failed":
                return result("private scanner error", code=125)
            findings = []
            if self.fail == "bundle-secret":
                findings = [{"File": "/release/NOTES.md", "StartLine": 7, "RuleID": "generic-api-key",
                             "Match": "private scanner match", "Secret": "private scanner secret"}]
            (folder / "findings.json").write_text(json.dumps(findings))
            return result("private scanner output", code=3 if findings else 0)
        if args[:3] == ["gh", "attestation", "verify"]:
            self.assertIn(f"{bundle.REPOSITORY}/.github/workflows/release-images.yml", args)
            self.assertIn("refs/heads/main", args)
            self.assertEqual(args[args.index("--source-digest") + 1], self.sha)
            self.assertIn("--deny-self-hosted-runners", args)
            return result(code=int(self.fail == "attestation-denied"))
        if args[:2] == ["gh", "api"]:
            if args[:4] == ["gh", "api", "--paginate", "--slurp"]:
                if self.fail == "github-denied":
                    return result(code=1)
                listing = [] if self.draft is None else [self.draft | {"assets": [{"name": n} for n in self.assets]}]
                return result(json.dumps([listing]))
            if "--include" in args:
                if self.tag_sha is None:
                    return result("HTTP/2.0 404 Not Found", 1)
                return result("HTTP/2.0 200 OK")
            if "POST" in args:
                self.assertIsNone(self.tag_sha)
                self.assertIn(f"ref=refs/tags/{self.tag}", args)
                self.tag_sha = self.sha
                if self.fail == "after-tag":
                    return result(code=1)
                return result()
            return result(self.tag_sha)
        if args[:2] == ["gh", "release"]:
            command = args[2]
            self.assertEqual(args[3], self.tag)
            if command in ("create", "upload"):
                self.assertEqual(self.tag_sha, self.sha)
                self.assertNotIn("--clobber", args)
                if command == "create":
                    self.assertIn("--verify-tag", args)
                    self.assertIn("--draft", args)
                    self.assertIsNone(self.draft)
                    self.draft = {"tag_name": self.tag, "draft": True, "name": f"VPNShop {self.tag}",
                                  "body": Path(args[args.index("--notes-file") + 1]).read_text()}
                for path in map(Path, args[4:args.index("--repo")]):
                    self.assertNotIn(path.name, self.assets)
                    self.assets[path.name] = path.read_bytes()
                    if self.fail == "partial-upload":
                        return result(code=1)
                return result()
            if command == "download":
                target = Path(args[args.index("--dir") + 1])
                for index, arg in enumerate(args):
                    if arg == "--pattern":
                        name = args[index + 1]
                        (target / name).write_bytes(self.assets[name])
                return result()
            if command == "edit":
                self.assertIn("--draft=false", args)
                self.assertEqual(len(self.assets), 4)
                self.assertTrue(self.draft["draft"])
                self.draft["draft"] = False
                return result()
        self.fail_unexpected(args)

    def fail_unexpected(self, args):
        raise AssertionError(f"Unexpected release command: {args}")

    def assemble(self):
        with patch.object(release, "build_images") as build:
            release.prepare_plan("first-release", self.plan, False)
        build.assert_called_once_with(self.sha, sorted(bundle.IMAGE_KEYS))
        release.finalize(self.plan, self.tag, self.notes, self.output)
        self.assertEqual(len(self.pushes), 7)
        script = self.output / "vpnshop.sh"
        subprocess.run(["bash", "-n", script], check=True)
        self.assertIn(b"vpnshop CLI 2", subprocess.check_output([script, "version"]))
        second = self.root / "repeated"
        release.finalize(self.plan, self.tag, self.notes, second)
        for file in self.output.iterdir():
            self.assertEqual(file.read_bytes(), (second / file.name).read_bytes())

    def test_first_release_and_immutable_final_state(self):
        self.assemble()
        v2_publish.publish(self.tag, self.output)
        self.assertFalse(self.draft["draft"])
        for resume in (False, True):
            with self.assertRaisesRegex(bundle.ReleaseError, "already exists"):
                v2_publish.publish(self.tag, self.output, resume)

    def test_tag_only_and_partial_upload_resume(self):
        self.assemble()
        for failure in ("after-tag", "partial-upload"):
            self.fail = failure
            with self.assertRaises(subprocess.CalledProcessError):
                v2_publish.publish(self.tag, self.output, resume=failure == "partial-upload")
        self.assertEqual(len(self.assets), 1)
        self.fail = None
        v2_publish.publish(self.tag, self.output, resume=True)
        self.assertFalse(self.draft["draft"])

    def test_mismatched_draft_and_tag_are_preserved(self):
        self.assemble()
        self.fail = "partial-upload"
        with self.assertRaises(subprocess.CalledProcessError):
            v2_publish.publish(self.tag, self.output)
        self.fail = None
        name, = self.assets
        self.assets[name] = b"mismatch"
        with self.assertRaisesRegex(bundle.ReleaseError, "differ"):
            v2_publish.publish(self.tag, self.output, resume=True)
        self.assertEqual(self.assets, {name: b"mismatch"})
        self.tag_sha = "b" * 40
        with self.assertRaisesRegex(bundle.ReleaseError, "candidate commit"):
            v2_publish.publish(self.tag, self.output, resume=True)
        self.assertTrue(self.draft["draft"])

    def test_provenance_permissions_and_corruption_fail_before_tag_creation(self):
        self.assemble()
        for failure in ("github-denied", "attestation-denied"):
            self.fail = failure
            with self.assertRaises(subprocess.CalledProcessError):
                v2_publish.publish(self.tag, self.output)
        self.fail = None
        (self.output / "vpnshop.sh").write_text("damaged")
        with self.assertRaisesRegex(bundle.ReleaseError, "checksum"):
            v2_publish.publish(self.tag, self.output)
        self.assertIsNone(self.tag_sha)

    def test_registry_permission_and_config_id_mismatch_stop_the_bundle(self):
        with patch.object(release, "build_images"):
            release.prepare_plan("first-release", self.plan, False)
        self.fail = "registry-denied"
        with self.assertRaises(subprocess.CalledProcessError):
            release.finalize(self.plan, self.tag, self.notes, self.output)
        self.fail = "registry-mismatch"
        with self.assertRaisesRegex(bundle.ReleaseError, "differs from tested image"):
            release.finalize(self.plan, self.tag, self.notes, self.output)
        self.assertFalse(self.output.exists())

    def test_bundle_scan_blocks_registry_and_tag_writes_with_safe_evidence(self):
        with patch.object(release, "build_images"):
            release.prepare_plan("first-release", self.plan, False)
        report = self.root / "diagnostics" / "scan.json"
        self.fail = "scanner-failed"
        with self.assertRaisesRegex(bundle.ReleaseError, "secret scan"):
            release.finalize(self.plan, self.tag, self.notes, self.output, report)
        self.assertEqual(json.loads(report.read_text()), {"status": "ERROR", "findings": []})
        self.fail = "bundle-secret"
        with self.assertRaisesRegex(bundle.ReleaseError, "secret scan"):
            release.finalize(self.plan, self.tag, self.notes, self.output, report)
        self.assertEqual(json.loads(report.read_text()), {"status": "FINDINGS", "findings": [
            {"file": "NOTES.md", "line": 7, "ruleId": "generic-api-key"},
        ]})
        self.assertFalse(self.pushes)
        self.assertFalse(self.output.exists())
        self.fail = None
        self.assemble()
        self.fail = "bundle-secret"
        with self.assertRaisesRegex(bundle.ReleaseError, "secret scan"):
            v2_publish.publish(self.tag, self.output, scan_report=report)
        self.assertIsNone(self.tag_sha)
        self.assertIsNone(self.draft)

    def test_invalid_release_notes_stop_before_registry_writes(self):
        with patch.object(release, "build_images"):
            release.prepare_plan("first-release", self.plan, False)
        self.notes.write_text("{}")
        with self.assertRaisesRegex(bundle.ReleaseError, "notes are incomplete"):
            release.finalize(self.plan, self.tag, self.notes, self.output)
        self.assertFalse(self.pushes)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
