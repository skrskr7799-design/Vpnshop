#!/usr/bin/env python3
"""Regression checks for the VPS command failures."""
import errno
import os
import pty
import select
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import vpnshop_cli as cli


class OperationsTests(unittest.TestCase):
    def test_docker_diagnostics_only_print_trusted_details(self):
        for detail, code, service in (
            (b"vpnshop-single-db-1 Error: range of CPUs is from 0.01 to 1.00", "RESOURCE_LIMIT", "db"),
            (b"vpnshop-single-admin-api-1 is unhealthy", "UNHEALTHY", "admin-api"),
            (b"unexpected test DSN", "DOCKER_FAILED", None),
        ):
            failure = cli.docker_failure(subprocess.CompletedProcess([], 1, b"", detail + b" fixture-sensitive-body"),
                                         "start", ("db", "admin-api", "api"))
            self.assertEqual((failure.stage, failure.code, failure.service), ("start", code, service))
            self.assertNotIn("fixture-sensitive-body", str(failure))
        failure = cli.docker_failure(subprocess.CompletedProcess([], 1, b"", b"unauthorized"), "pull", ("web",))
        self.assertEqual((failure.stage, failure.code, failure.service), ("pull", "REGISTRY_AUTH", "web"))

    def terminal(self, dialogs, child):
        pid, fd = pty.fork()
        if not pid:
            try:
                child()
            except Exception:
                os._exit(1)
            os._exit(0)
        transcript = b""
        try:
            for prompt, value in dialogs:
                offset = len(transcript)
                while prompt not in transcript[offset:]:
                    readable, _, _ = select.select([fd], [], [], 5)
                    self.assertTrue(readable, "Expected interactive prompt")
                    transcript += os.read(fd, 4096)
                os.write(fd, value)
            while True:
                readable, _, _ = select.select([fd], [], [], 5)
                self.assertTrue(readable, "Interactive command did not exit")
                try:
                    chunk = os.read(fd, 4096)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                transcript += chunk
        finally:
            os.close(fd)
            _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        return transcript

    def test_migration_prompt_shows_exact_version_and_retries(self):
        prompt = b"Type 'v2.0.2' to continue"
        transcript = self.terminal([(prompt, b"yes\n"), (prompt, b"v2.0.2\n")],
                                   lambda: cli.ask("Migration changes PostgreSQL.", phrase="v2.0.2", retry=True))
        self.assertIn(b"did not match", transcript)

    def test_interactive_owner_prompts_do_not_echo_password(self):
        password = b"pty-fixture-password-41"

        def read_owner():
            assert cli.tty_read("Staff username: ") == "owner"
            assert cli.tty_password() == password.decode()

        terminal = self.terminal([
            (b"Staff username:", b"owner\n"), (b"New password", password + b"\n"),
            (b"Confirm password:", password + b"\n"),
        ], read_owner)
        self.assertNotIn(password, terminal)

    def test_recovery_prompts_confirm_identity_and_hide_password(self):
        password = b"pty-recovery-fixture-17"
        command = cli.parser().parse_args(["admin", "recover", "--incident", "VPS-1234"])
        deployment = SimpleNamespace(role="single", pointer=lambda _: cli.Path("v2.0.1"), log=lambda *_a, **_kw: None)
        def recover():
            def compose(*args, input, check):
                data = cli.json.loads(input)
                assert args[-2:] == ("admin-local", "recover")
                assert data["username"] == "owner" and data["password"] == password.decode()
                return subprocess.CompletedProcess(args, 0, b'{"username":"owner"}', b"")
            runtime = SimpleNamespace(inventory=lambda: ({},), history={}, compose=compose)
            with patch.object(cli, "Runtime", return_value=runtime):
                cli.Deployment.local_admin(deployment, command)
        transcript = self.terminal([
            (b"Staff username:", b"owner\n"), (b"Type the username", b"owner\n"),
            (b"New password", password + b"\n"), (b"Confirm password:", password + b"\n"),
        ], recover)
        self.assertNotIn(password, transcript)
        self.assertIn(b"Administrative command committed", transcript)

    def test_interrupted_terminal_and_missing_terminal_fail_closed(self):
        def eof():
            try:
                cli.tty_read("Username: ")
            except cli.ReleaseError:
                return
            raise AssertionError("EOF must not be accepted")

        self.terminal([(b"Username:", b"\x04")], eof)
        process = subprocess.run(
            [cli.sys.executable, "-c", "from vpnshop_cli import tty_password; tty_password()"],
            cwd=cli.Path(__file__).parent, start_new_session=True, capture_output=True, check=False,
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertIn(b"Hidden password input unavailable", process.stderr)


if __name__ == "__main__":
    unittest.main()
