#!/usr/bin/env python3
"""Evaluate the explicitly accepted Bookworm image findings without filtering Trivy."""
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

EXPIRES = datetime(2027, 5, 27, tzinfo=timezone.utc)
MAX_DB_AGE = timedelta(days=7)
BOOKWORM_ACCEPTANCES = {
    "CVE-2023-45853": ("zlib1g", "1:1.2.13.dfsg-1", "will_not_fix"),
    "CVE-2025-7458": ("libsqlite3-0", "3.40.1-2+deb12u2", "affected"),
    "CVE-2026-6653": ("libxml2", "2.9.14+dfsg-1.3~deb12u6", "fix_deferred"),
}


def database_fresh(metadata, now):
    updated = datetime.fromisoformat(metadata["UpdatedAt"].replace("Z", "+00:00"))
    return metadata["Version"] == 2 and timedelta() <= now - updated <= MAX_DB_AGE


def evaluate(image, report, metadata, versions, now):
    if report["SchemaVersion"] != 2 or report["ArtifactType"] != "container_image":
        raise ValueError("Unexpected Trivy report")
    host = report["Metadata"]
    os = host.get("OS") or {}
    config = host["ImageConfig"]
    fresh = database_fresh(metadata, now)
    eligible = (
        image in {"db", "backup"} and fresh and now < EXPIRES
        and config.get("os") == "linux" and config.get("architecture") == "amd64"
        and os.get("Family") == "debian" and re.fullmatch(r"12(?:\.\d+)?", os.get("Name", ""))
    )

    accepted = []
    findings = []
    for result in report["Results"]:
        for finding in result.get("Vulnerabilities") or []:
            if finding["Severity"] == "CRITICAL":
                findings.append((result, finding))
    # A fixed version reported in any result for this pair vetoes its acceptance
    # even if the scanner also returned another entry with the old status.
    fixed_pairs = {
        (finding["VulnerabilityID"], finding["PkgName"])
        for result in report["Results"]
        for finding in result.get("Vulnerabilities") or []
        if finding.get("FixedVersion") not in (None, "")
    }
    for result, finding in findings:
        if not eligible or result["Class"] != "os-pkgs" or result["Type"] != "debian":
            continue
        cve, package = finding["VulnerabilityID"], finding["PkgName"]
        key = (package, finding["InstalledVersion"], finding.get("Status"))
        if ((cve, package) not in fixed_pairs and BOOKWORM_ACCEPTANCES.get(cve) == key
                and (finding.get("DataSource") or {}).get("ID") == "debian"
                and versions.get(package) == key[1]):
            accepted.append({"id": cve, "package": package, "installed": key[1], "status": key[2]})
    return {
        "critical": len(findings), "acceptedCritical": len(accepted),
        "blockingCritical": len(findings) - len(accepted), "acceptances": accepted,
        "databaseFresh": fresh, "bookwormVersions": {
            package: versions.get(package) for package, _, _ in BOOKWORM_ACCEPTANCES.values()
        } if image in {"db", "backup"} else {}, "expiresAt": EXPIRES.isoformat(),
    }


def require_publication_window(summary, now):
    if summary["failed"] is not False:
        raise ValueError("Security gate did not pass")
    if now >= EXPIRES and any(image["acceptedCritical"] for image in summary["images"].values()):
        raise ValueError("Temporary Bookworm approval expired")


def main(args):
    if len(args) == 2 and args[0] == "verify-publication-window":
        require_publication_window(json.loads(Path(args[1]).read_text()), datetime.now(timezone.utc))
    else:
        image, report_path, metadata_path, versions_path = args
        report = json.loads(Path(report_path).read_text())
        metadata = json.loads(Path(metadata_path).read_text())
        versions = {}
        for line in Path(versions_path).read_text().splitlines():
            package, version = line.split()
            if package in versions or not re.fullmatch(r"[a-zA-Z0-9:+.~-]{1,128}", version):
                raise ValueError("Invalid package version evidence")
            versions[package] = version
        print(json.dumps(evaluate(image, report, metadata, versions, datetime.now(timezone.utc))))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        sys.exit("Release risk policy verification failed. See the sanitized security gate reports.")
