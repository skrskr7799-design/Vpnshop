#!/usr/bin/env python3
"""Exercise the pinned Docker scanner with a synthetic credential in release notes."""
import json
import tempfile
import unittest
from pathlib import Path

import v2_release as release
from release_bundle_scan import scan_archive


class BundleScanner(unittest.TestCase):
    def test_synthetic_credential_in_archive_still_blocks(self):
        # Construct a nonfunctional GitHub token fixture without putting it in the source.
        synthetic = "ghp" + "_" + "O094lHvOkUTJe1UNzziVS3KhgDScInQGYYfp"
        notes = dict.fromkeys(release.NOTE_FIELDS, "Bundle scanner fixture.")
        notes.update(coordination="compatible", changes="GITHUB_TOKEN=" + synthetic)
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            sha = release.git("rev-parse", "HEAD")
            archive = release.make_bundle(directory, "v0.0.0", sha,
                                          release.fixture_entries(sha, release.fingerprints()),
                                          release.migration_history(), None, notes)
            report = directory / "scan.json"
            with self.assertRaisesRegex(release.ReleaseError, "secret scan"):
                scan_archive(archive, release.run, report)
            evidence = json.loads(report.read_text())
            self.assertEqual(evidence["status"], "FINDINGS")
            self.assertTrue(any(item["file"] == "NOTES.md" and item["line"] > 0
                                and item["ruleId"] == "github-pat" for item in evidence["findings"]))
            self.assertTrue(all(set(item) == {"file", "line", "ruleId"} for item in evidence["findings"]))


if __name__ == "__main__":
    unittest.main()
