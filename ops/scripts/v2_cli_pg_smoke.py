#!/usr/bin/env python3
"""Exercise the CLI's logical recovery against only the disposable V2 Compose project."""
import os
from pathlib import Path
import sys
from unittest.mock import patch

import vpnshop_cli as cli
import v2_release as release
from release_bundle import NOTE_FIELDS, demand, unpack


def main(arguments):
    project = os.environ["COMPOSE_PROJECT_NAME"]
    demand(project.startswith("mzt-ci-single-"), "Use only a disposable V2 Single project")
    scratch = Path(arguments[0])
    deployment = cli.Deployment(scratch / "installation", scratch / "not-installed")
    for path in (deployment.root, deployment.state, deployment.releases, deployment.backups):
        path.mkdir(mode=0o700)
    (deployment.state / "role").write_text("single\n")
    (deployment.state / "role").chmod(0o600)
    sha = release.git("rev-parse", "HEAD")
    notes = dict.fromkeys(NOTE_FIELDS, "Disposable PostgreSQL 17 recovery smoke.")
    notes["coordination"] = "compatible"
    archive = release.make_bundle(scratch / "candidate", "v0.0.0", sha,
                                  release.fixture_entries(sha, release.fingerprints()),
                                  release.migration_history(), None, notes)
    selected = deployment.releases / "v0.0.0"
    selected.mkdir()
    unpack(archive, selected)
    deployment.switch("current", selected)
    original = cli.Runtime

    class FixtureRuntime(original):
        def __init__(self, installed, path, **kwargs):
            self.command, self.env = ["docker", "compose", *arguments[1:]], os.environ.copy()
            self.release, self.role, self.secrets = path, installed.role, installed.secrets
            config = self.compose("--profile", "*", "config", "--format", "json")
            self.config = cli.json.loads(config.stdout)
            self.services = self.config["services"]
            self.values, self.history, self.metadata = cli.manifest(path)
            self.flags, self.settings = set(), {}

        def https_health(self, service):
            # TLS/ACL is independently covered in the same smoke. Passwords never reach the host.
            return True

    with patch.object(cli, "Runtime", FixtureRuntime), patch.object(cli, "ask"):
        runtime = cli.Runtime(deployment, selected)
        demand(runtime.inventory()[0] == runtime.history, "Live migration checksums differ")
        runtime.sql("""INSERT INTO "Plan"(id,code,name,"deviceLimit")
                    VALUES ('cli-backup-baseline','cli-backup-baseline','CLI backup baseline',3);""")
        original_oid = runtime.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres")
        volume = runtime.compose("ps", "-q", "db").stdout
        print("Verify and export the synthetic backup.", flush=True)
        backup = deployment.backup(runtime)
        runtime.sql("""INSERT INTO "Plan"(id,code,name,"deviceLimit")
                    VALUES ('cli-after-backup','cli-after-backup','CLI after backup',3);""")
        print("Restore into a scratch database and interrupt after the swap.", flush=True)
        with patch.object(FixtureRuntime, "start", side_effect=cli.ReleaseError("Injected interruption after database swap")):
            try:
                deployment.restore(backup)
                raise AssertionError("Expected interrupted restore")
            except cli.ReleaseError as problem:
                if str(problem) != "Injected interruption after database swap":
                    raise
        pending = deployment.read_pending()
        demand(pending["phase"] == "restore-starting" and pending["oldOid"] == original_oid, "Missing recovery journal")
        safe_backup = pending["safetyBackup"]
        demand(safe_backup and safe_backup != backup, "Missing defensive backup")
        deployment.recover(cli.parser().parse_args(["recover"]))
        demand(deployment.read_pending() is None, "Recovery left a pending operation")
        demand(runtime.compose("ps", "-q", "db").stdout == volume, "Database container changed during logical restore")
        demand(runtime.sql("""SELECT count(*)=1 AND bool_and(id='cli-backup-baseline')
                    FROM "Plan" WHERE id IN ('cli-backup-baseline','cli-after-backup');""") == "t", "Restored dataset differs")
        demand(runtime.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres") != original_oid,
               "Recovery did not switch database identity")
        demand(runtime.sql(f"SELECT oid FROM pg_database WHERE datname='{pending['retained']}' AND NOT datallowconn;",
                           "postgres") == original_oid, "Original database was not retained with connections disabled")
        demand(runtime.inventory()[0] == runtime.history, "Restored PostgreSQL history did not verify")
        deployment.backup_record(safe_backup, runtime)
    print("PASS: PostgreSQL 17 backup, verified decrypt, scratch restore, atomic switch, interrupted recovery, preserved DB container and history.")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except cli.ReleaseError as problem:
        sys.exit(str(problem))
