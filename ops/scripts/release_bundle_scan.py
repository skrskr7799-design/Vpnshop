"""Run the pinned scanner on extracted release assets and retain only safe locations."""
import json
import os
import sys
import tempfile
from pathlib import Path, PurePosixPath

from release_bundle import allowed_member, atomic, demand, matches, unpack

GITLEAKS = "zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9"
FINDINGS_EXIT = 3


def safe_finding(finding, extracted):
    file = PurePosixPath(finding["File"])
    if file.is_absolute() and file.is_relative_to("/release"):
        file = file.relative_to("/release")
    location = file.as_posix()
    line = finding["StartLine"]
    rule = finding["RuleID"]
    return {
        "file": location if len(location) <= 200 and allowed_member(location)
        and (extracted / location).is_file() else "withheld",
        "line": line if type(line) is int and line > 0 else None,
        "ruleId": rule if matches(r"[A-Za-z0-9_.-]{1,80}", rule) else "withheld",
    }


def scan_extracted(extracted, run, report=None):
    # Raw scanner output stays in a private temporary directory and is never logged.
    with tempfile.TemporaryDirectory() as folder:
        raw = Path(folder) / "findings.json"
        result = run([
            "docker", "run", "--rm", "--network", "none", "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", f"{extracted}:/release:ro", "-v", f"{folder}:/report", GITLEAKS,
            "dir", "--no-banner", "--redact=100", "--exit-code", str(FINDINGS_EXIT),
            "--report-format", "json", "--report-path", "/report/findings.json", "/release",
        ], check=False, capture_output=True)
        status, findings = "ERROR", []
        try:
            if result.returncode in (0, FINDINGS_EXIT):
                parsed = json.loads(raw.read_text())
                if isinstance(parsed, list) and bool(parsed) == (result.returncode == FINDINGS_EXIT):
                    findings = [safe_finding(item, extracted) for item in parsed]
                    status = "FINDINGS" if findings else "PASS"
        except (KeyError, OSError, TypeError, ValueError):
            pass
    summary = {"status": status, "findings": findings}
    if report is not None:
        report.parent.mkdir(parents=True, exist_ok=True)
        atomic(report, (json.dumps(summary) + "\n").encode())
    print("Deploy bundle Gitleaks: " + json.dumps(summary), file=sys.stderr)
    demand(status == "PASS", "Deploy bundle secret scan did not pass")


def scan_archive(archive, run, report=None):
    with tempfile.TemporaryDirectory() as folder:
        extracted = Path(folder)
        unpack(archive, extracted)
        scan_extracted(extracted, run, report)
