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
        stack = arguments[1:]

        def __init__(self, installed, path, **kwargs):
            self.command, self.env = ["docker", "compose", *self.stack], os.environ.copy()
            self.project = project
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
        mail_at = FixtureRuntime.stack.index("ops/compose/mail.yml")
        demand(FixtureRuntime.stack[mail_at - 1] == "-f", "Mail overlay must be a separate Compose file")

        class NoMailRuntime(FixtureRuntime):
            stack = FixtureRuntime.stack[:mail_at - 1] + FixtureRuntime.stack[mail_at + 1:]

        queue = "SELECT id FROM \"NotificationOutbox\" ORDER BY id;"
        queued_messages = runtime.sql(queue)
        demand(queued_messages and runtime.containers()["notifications"]["State"] == "running", "Mail fixture is not active")
        no_mail = NoMailRuntime(deployment, selected)
        no_mail.start()
        no_mail.verify_live()
        demand(not any(row[1] == "notifications" for row in no_mail.project_containers()), "SMTP worker survived overlay removal")
        demand(runtime.sql(queue) == queued_messages, "Enabling or disabling SMTP changed the persisted queue")
        runtime.start()
        runtime.verify_live()
        demand(runtime.containers()["notifications"]["State"] == "running", "SMTP worker did not restart after re-enabling")

        runtime.sql("""INSERT INTO "Plan"(id,code,name,"deviceLimit")
                    VALUES ('cli-backup-baseline','cli-backup-baseline','CLI backup baseline',3);""")
        original_oid = runtime.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres")
        volume = runtime.compose("ps", "-q", "db").stdout
        print("Verify and export the synthetic backup.", flush=True)
        backup = deployment.backup(runtime)
        runtime.sql("""INSERT INTO "Plan"(id,code,name,"deviceLimit")
                    VALUES ('cli-after-backup','cli-after-backup','CLI after backup',3);""")
        def fails(action, message):
            try:
                action()
            except cli.ReleaseError as problem:
                demand(message in str(problem), str(problem))
            else:
                raise AssertionError("Expected failure: " + message)

        def only_database():
            demand({row[1] for row in runtime.project_containers()} == {"db"}, "Restore left restartable workloads")

        print("Interrupt restore before and after the database swap.", flush=True)
        sql = FixtureRuntime.sql

        def interrupt_swap(apply_swap):
            def interrupted(instance, statement, *args, **kwargs):
                if "RENAME TO vpnshop" in statement:
                    if apply_swap:
                        sql(instance, statement, *args, **kwargs)
                    raise cli.ReleaseError("Injected interruption at database swap")
                return sql(instance, statement, *args, **kwargs)
            return patch.object(FixtureRuntime, "sql", interrupted)

        recover = cli.parser().parse_args(["recover"])
        with interrupt_swap(False):
            fails(lambda: deployment.restore(backup), "Injected interruption")
        only_database()
        demand(runtime.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres") == original_oid,
               "Database swapped before the injected failure")
        with interrupt_swap(True):
            fails(lambda: deployment.recover(recover), "Injected interruption")
        only_database()
        pending = deployment.read_pending()
        demand(pending["phase"] == "swap-prepared" and pending["oldOid"] == original_oid, "Missing recovery journal")
        safe_backup = pending["safetyBackup"]
        demand(safe_backup and safe_backup != backup, "Missing defensive backup")
        deployment.recover(recover)
        deployment.recover(recover)
        demand(deployment.read_pending()["phase"] == cli.RESTORE_REVIEW, "Recovery bypassed reconciliation")
        only_database()
        for args in (["up"], ["restart"], ["restart", "public-api"], ["update", "latest"], ["backup"]):
            fails(lambda: cli.execute(cli.parser().parse_args(args), deployment), "awaiting reconciliation")
        fails(lambda: deployment.recover(cli.parser().parse_args(["recover", "--cancel", "--yes"])), "Cannot cancel")
        fails(lambda: deployment.finish_restore("wrong-operation"), "Confirmation ID")
        runtime.compose("restart", "db")
        runtime.start("db")
        only_database()
        demand(runtime.compose("ps", "-q", "db").stdout == volume, "Database container changed during logical restore")
        demand(runtime.sql("""SELECT count(*)=1 AND bool_and(id='cli-backup-baseline')
                    FROM "Plan" WHERE id IN ('cli-backup-baseline','cli-after-backup');""") == "t", "Restored dataset differs")
        demand(runtime.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres") != original_oid,
               "Recovery did not switch database identity")
        demand(runtime.sql(f"SELECT oid FROM pg_database WHERE datname='{pending['retained']}' AND NOT datallowconn;",
                           "postgres") == original_oid, "Original database was not retained with connections disabled")
        demand(runtime.inventory()[0] == runtime.history, "Restored PostgreSQL history did not verify")
        deployment.backup_record(safe_backup, runtime)
        restore_id = pending["scratch"]
        with patch.object(FixtureRuntime, "verify_live", side_effect=cli.ReleaseError("Injected readiness failure")):
            fails(lambda: deployment.finish_restore(restore_id), "Injected readiness failure")
        only_database()
        demand(deployment.read_pending()["phase"] == cli.RESTORE_REVIEW, "Readiness failure dropped the restore barrier")
        with patch.object(cli, "ask", side_effect=cli.ReleaseError("Operation was not confirmed")) as confirm:
            fails(lambda: deployment.finish_restore(restore_id), "not confirmed")
            demand(confirm.call_args.kwargs.get("phrase") == restore_id, "Confirmation is not tied to this restore")
        only_database()
        deployment.finish_restore(restore_id)
        demand(deployment.read_pending() is None, "Successful finish left a pending operation")
        runtime.verify_live()
    print("PASS: SMTP reconciliation, PostgreSQL 17 backup, interrupted swap, durable review and explicit restore completion.")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except cli.ReleaseError as problem:
        sys.exit(str(problem))
