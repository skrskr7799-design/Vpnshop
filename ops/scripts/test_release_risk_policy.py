#!/usr/bin/env python3
import copy
import unittest
from datetime import datetime, timedelta, timezone

from release_risk_policy import (
    BOOKWORM_ACCEPTANCES, EXPIRES, MAX_DB_AGE, evaluate, require_publication_window,
)

NOW = datetime(2026, 11, 27, tzinfo=timezone.utc)


class ReleaseRiskPolicy(unittest.TestCase):
    def setUp(self):
        self.findings = [
            {"VulnerabilityID": cve, "PkgName": package, "InstalledVersion": version,
             "Status": status, "Severity": "CRITICAL", "DataSource": {"ID": "debian"}}
            for cve, (package, version, status) in BOOKWORM_ACCEPTANCES.items()
        ]
        self.versions = {package: version for package, version, _ in BOOKWORM_ACCEPTANCES.values()}
        self.report = {
            "SchemaVersion": 2, "ArtifactType": "container_image",
            "Metadata": {"OS": {"Family": "debian", "Name": "12.15"},
                         "ImageConfig": {"architecture": "amd64", "os": "linux"}},
            "Results": [{"Class": "os-pkgs", "Type": "debian", "Vulnerabilities": self.findings}],
        }

    def decide(self, image="db", now=NOW, updated=None):
        metadata = {"Version": 2, "UpdatedAt": (updated or now).isoformat()}
        return evaluate(image, self.report, metadata, self.versions, now)

    def test_both_approved_images_keep_all_findings_visible(self):
        initial = copy.deepcopy(self.report)
        for image in ("db", "backup"):
            with self.subTest(image=image):
                result = self.decide(image)
                self.assertEqual(result["critical"], 3)
                self.assertEqual(result["acceptedCritical"], 3)
                self.assertEqual(result["blockingCritical"], 0)
                self.assertEqual({finding["id"] for finding in result["acceptances"]}, set(BOOKWORM_ACCEPTANCES))
                self.assertEqual(result["expiresAt"], EXPIRES.isoformat())
        self.assertEqual(self.report, initial)

    def test_other_images_platforms_releases_and_sources_cannot_apply(self):
        self.assertEqual(self.decide("application")["blockingCritical"], 3)
        os_info = self.report["Metadata"]["OS"]
        os_info["Name"] = "13.0"
        self.assertEqual(self.decide()["blockingCritical"], 3)
        os_info["Name"] = "12.15"
        self.report["Metadata"]["ImageConfig"]["architecture"] = "arm64"
        self.assertEqual(self.decide()["blockingCritical"], 3)
        self.report["Metadata"]["ImageConfig"]["architecture"] = "amd64"
        self.report["Results"][0]["Class"] = "lang-pkgs"
        self.assertEqual(self.decide()["blockingCritical"], 3)
        self.report["Results"][0]["Class"] = "os-pkgs"
        self.findings[0]["DataSource"]["ID"] = "unknown"
        self.assertEqual(self.decide()["blockingCritical"], 1)

    def test_expiration_in_utc_and_stale_vendor_database(self):
        self.assertEqual(self.decide(now=EXPIRES - timedelta(seconds=1))["acceptedCritical"], 3)
        self.assertEqual(self.decide(now=EXPIRES)["blockingCritical"], 3)
        self.assertEqual(self.decide(now=EXPIRES + timedelta(days=1))["blockingCritical"], 3)
        result = self.decide(updated=NOW - MAX_DB_AGE - timedelta(seconds=1))
        self.assertEqual(result["blockingCritical"], 3)
        self.assertFalse(result["databaseFresh"])
        self.assertEqual(self.decide(updated=NOW + timedelta(seconds=1))["blockingCritical"], 3)

    def test_new_finding_or_different_package_version_and_status_blocks(self):
        for field, value in (
            ("VulnerabilityID", "CVE-2026-99999"), ("PkgName", "libminizip1"),
            ("InstalledVersion", "1:1.2.13.dfsg-2"), ("Status", "unknown"),
        ):
            with self.subTest(field=field):
                original = self.findings[0][field]
                self.findings[0][field] = value
                self.assertEqual(self.decide()["blockingCritical"], 1)
                self.findings[0][field] = original
        self.findings.append(self.findings[0] | {"VulnerabilityID": "CVE-2026-99999"})
        self.assertEqual(self.decide()["blockingCritical"], 1)

    def test_reported_fixed_version_vetoes_even_if_status_is_unchanged(self):
        for finding in self.findings:
            with self.subTest(cve=finding["VulnerabilityID"]):
                finding["FixedVersion"] = "bookworm-fixed-version"
                self.assertEqual(self.decide()["blockingCritical"], 1)
                duplicate = dict(finding, Severity="HIGH")
                finding.pop("FixedVersion")
                self.findings.append(duplicate)
                self.assertEqual(self.decide()["blockingCritical"], 1)
                self.findings.pop()

    def test_live_index_change_or_missing_version_vetoes_acceptance(self):
        self.versions["libsqlite3-0"] += "+patched"
        self.assertEqual(self.decide()["blockingCritical"], 1)
        self.versions.pop("zlib1g")
        self.assertEqual(self.decide()["blockingCritical"], 2)
        self.versions.clear()
        self.assertEqual(self.decide()["blockingCritical"], 3)

    def test_approval_can_expire_between_scan_and_release_writes(self):
        summary = {"failed": False, "images": {"db": self.decide()}}
        require_publication_window(summary, EXPIRES - timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "approval expired"):
            require_publication_window(summary, EXPIRES)
        summary["images"]["db"]["acceptedCritical"] = 0
        require_publication_window(summary, EXPIRES)
        summary["failed"] = True
        with self.assertRaisesRegex(ValueError, "did not pass"):
            require_publication_window(summary, EXPIRES)

    def test_absent_and_invalid_evidence(self):
        self.findings.clear()
        self.assertEqual(self.decide(now=EXPIRES)["blockingCritical"], 0)
        del self.report["Results"]
        with self.assertRaises(KeyError):
            self.decide()


if __name__ == "__main__":
    unittest.main()
