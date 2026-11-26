"""VPNShop host operations. Bundled with the Bash launcher for a source-free install."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import getpass
from uuid import uuid4
import fcntl
import importlib.util
import ipaddress
import secrets as random
import shutil
import subprocess
import sys
import tempfile
from urllib import error, parse, request

sys.dont_write_bytecode = True

if "REPOSITORY" not in globals():
    from release_bundle import (
        HEX, IMAGE_KEYS, MAX_BUNDLE, REPOSITORY, ReleaseError, atomic, checksum, demand, digest_file,
        json, manifest, matches, os, Path, private_regular, re, stat, sync_directory, tarfile, tree_id, unpack, version,
    )

MARKER = "writers-stopped-isolated-target"
ACTIVE_PROFILES = {"monitoring"}
APP_WRITERS = ("public-api", "admin-api", "worker", "billing", "notifications")
BACKUP_ID = r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}"
POSTGRES_MAJOR = 17


def clock():
    return datetime.now(timezone.utc)


def safe_line(label, value):
    print(f"{label:<24} {value}", flush=True)


def notify(message, color="32"):
    terminal = sys.stdout.isatty() and "NO_COLOR" not in os.environ
    print(f"\033[{color}m{message}\033[0m" if terminal else message, flush=True)


def call(args, *, input=None, stdin=None, stdout=subprocess.PIPE, env=None, timeout=180, check=True):
    process = subprocess.run(args, input=input, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE, env=env,
                             timeout=timeout, check=False)
    if check and process.returncode:
        # Docker, GitHub, psql and provider error bodies can contain private paths or credentials.
        raise ReleaseError(f"{Path(args[0]).name} operation failed with exit code {process.returncode}")
    return process


def ask(prompt, *, yes=False, phrase="yes"):
    if yes:
        return
    print(prompt, flush=True)
    try:
        with open("/dev/tty", encoding="utf-8") as terminal:
            confirmed = terminal.readline().strip()
    except OSError:
        confirmed = ""
    demand(confirmed == phrase, "Operation was not confirmed")


def checked_dir(path):
    info = path.lstat()
    demand(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022,
           "Installation path must be a protected, operator-owned directory")
    return path


def module(path):
    spec = importlib.util.spec_from_file_location("vpnshop_preflight", path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class GitHubRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = parse.urlsplit(newurl)
        demand(url.scheme == "https" and url.hostname in {
            "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
        } and url.port in (None, 443) and url.username is None, "Untrusted GitHub asset redirect")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            redirected.remove_header("Authorization")
        return redirected


class ReleaseSource:
    def __init__(self, token_file=None):
        self.token = private_regular(token_file) if token_file else None
        demand(self.token is None or bool(re.fullmatch(r"[A-Za-z0-9_]+", self.token)), "Invalid GitHub read credential format")
        self.opener = request.build_opener(GitHubRedirect())

    def get(self, url, limit, *, asset=False):
        headers = {"Accept": "application/octet-stream" if asset else "application/vnd.github+json",
                   "User-Agent": "vpnshop-release-cli", "X-GitHub-Api-Version": "2022-11-28"}
        req = request.Request(url, headers=headers)
        if self.token:
            req.add_unredirected_header("Authorization", "Bearer " + self.token)
        try:
            with self.opener.open(req, timeout=25) as response:
                content = response.read(limit + 1)
        except (error.URLError, TimeoutError):
            raise ReleaseError("GitHub Release unavailable. Check the repository, version and read credential.") from None
        demand(len(content) <= limit, "GitHub asset exceeds release size limits")
        return content

    def fetch(self, selection, directory, *, pinned=None, attest=False):
        base = f"https://api.github.com/repos/{REPOSITORY}/releases"
        selected = "latest" if selection == "latest" else "tags/" + version(selection)
        meta = json.loads(self.get(base + "/" + selected, 512 * 1024))
        tag = version(meta["tag_name"])
        demand(not meta["draft"] and not meta["prerelease"]
               and (selection == "latest" or tag == selection)
               and meta["html_url"] == f"https://github.com/{REPOSITORY}/releases/tag/{tag}", "Unexpected GitHub Release metadata")
        archive = f"vpnshop-deploy-{tag}.tar.gz"
        sizes = {archive: MAX_BUNDLE, archive + ".sha256": 512}
        for name, limit in sizes.items():
            assets = [asset for asset in meta["assets"] if asset["name"] == name and asset["state"] == "uploaded"]
            demand(len(assets) == 1 and isinstance(assets[0]["id"], int), "Required release asset is missing or ambiguous")
            item = assets[0]
            demand(item["url"] == base + f"/assets/{item['id']}" and
                   item["browser_download_url"] == f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}",
                   "Unexpected GitHub asset origin")
            url = item["url"] if self.token else item["browser_download_url"]
            (directory / name).write_bytes(self.get(url, limit, asset=True))
        bundle = directory / archive
        checksum(bundle, directory / (archive + ".sha256"))
        if pinned:
            demand(matches(HEX, pinned) and digest_file(bundle) == pinned, "Archive differs from the operator-pinned digest")
        if attest:
            demand(shutil.which("gh"), "GitHub CLI with attestation verification is required for --attest")
            environment = os.environ | ({"GH_TOKEN": self.token} if self.token else {})
            call(["gh", "attestation", "verify", str(bundle), "--repo", REPOSITORY, "--signer-workflow",
                  f"{REPOSITORY}/.github/workflows/release-images.yml", "--source-ref", "refs/heads/main",
                  "--deny-self-hosted-runners"], env=environment)
        if not pinned and not attest:
            notify("Release verified against GitHub HTTPS and the published SHA-256. Provenance attestation not requested.", "33")
        return tag, bundle


class Runtime:
    def __init__(self, deployment, release, *, allow_pull=False, read_only=False):
        self.release, self.role, self.secrets = release, deployment.role, deployment.secrets
        self.values, self.history, self.metadata = manifest(release)
        api = module(release / "scripts/preflight.py")
        self.api = api
        self.settings, files, self.flags = api.design(deployment.role, api.read_settings(deployment.config), deployment.secrets)
        path = deployment.monitoring_path(release, create=not read_only)
        self.command, self.env, self.config = api.compose(
            self.settings, deployment.role, files, deployment.secrets, self.values,
            f"vpnshop-{deployment.role}", False, project_dir=deployment.root, monitoring_dir=path,
        )
        api.hardened(self.config, False)
        api.validate_topology(self.config, deployment.role, self.settings, self.flags, files)
        api.verify_secrets(self.config, deployment.role, self.settings, self.flags, deployment.secrets, None)
        if allow_pull:
            self.ensure_images()
        if not read_only:
            self.validate_owners()
        self.services = self.config["services"]

    def validate_owners(self):
        owner = self.api.host_ownership(self.values["EDGE_IMAGE"], self.env)
        self.api.verify_secrets(self.config, self.role, self.settings, self.flags, self.secrets, owner)

    def check_owners_read_only(self):
        options = call(["docker", "info", "--format", "{{json .SecurityOptions}}"]).stdout.decode()
        if "rootless" in options or "userns" in options:
            return "NOT CHECKED: namespace mapping is verified at deployment time"
        self.validate_owners()
        return "OK"

    def ensure_images(self):
        for reference in sorted({item["image"] for item in self.config["services"].values()}):
            if call(["docker", "image", "inspect", reference], check=False).returncode:
                call(["docker", "pull", reference], timeout=900)

    def compose(self, *args, timeout=180, input=None, stdin=None, stdout=subprocess.PIPE, check=True):
        return call(self.command + list(args), env=self.env, timeout=timeout, input=input, stdin=stdin,
                    stdout=stdout, check=check)

    def sql(self, sql, database="vpnshop", *, exec_args=()):
        return self.compose("exec", "-T", *exec_args, "db", "psql", "-XqAt", "-v", "ON_ERROR_STOP=1",
                            "-U", "postgres", "-d", database, input=sql.encode()).stdout.decode().strip()

    def inventory(self, database="vpnshop"):
        table, count, size, pg = self.sql(
            "SELECT to_regclass('public._prisma_migrations') IS NOT NULL, "
            "(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'),"
            "pg_database_size(current_database()),current_setting('server_version_num');",
            database,
        ).split("|")
        demand(int(pg) // 10000 == POSTGRES_MAJOR, "Unsupported PostgreSQL major version")
        if table == "f":
            demand(count == "0", "Database is initialized without a tracked Prisma migration history")
            return {}, int(size), int(pg)
        rows = json.loads(self.sql(
            """SELECT coalesce(json_agg(json_build_array(migration_name,checksum,finished_at IS NOT NULL,
               rolled_back_at IS NOT NULL) ORDER BY migration_name,started_at), '[]'::json)
               FROM public._prisma_migrations;""", database,
        ))
        history = {}
        for name, digest, completed, rolled_back in rows:
            if rolled_back:
                continue
            demand(completed and name not in history and matches(HEX, digest),
                   "PostgreSQL contains a failed or ambiguous migration. Inspect the database before continuing.")
            history[name] = digest
        demand(history or count == "1", "PostgreSQL contains objects without a completed migration history")
        return history, int(size), int(pg)

    def migrate(self):
        actual = self.inventory()[0]
        migration_delta(actual, self.history)
        if actual != self.history:
            self.compose("run", "-T", "--rm", "--no-deps", "--pull", "never", "migrator", timeout=900)
            demand(self.inventory()[0] == self.history, "Migrator completed without the expected PostgreSQL history")

    def active(self):
        return [name for name, definition in self.services.items()
                if not definition.get("profiles") or ACTIVE_PROFILES.intersection(definition["profiles"])]

    def start(self, *services):
        converge = ("--remove-orphans",) if not services else ()
        self.compose("up", "-d", "--pull", "never", "--wait", "--wait-timeout", "150",
                     *converge, *services, timeout=260)

    def stop_writers(self):
        names = [name for name in APP_WRITERS if name in self.services]
        if names:
            call(self.command + ["--profile", "*", "stop", "--timeout", "120", *names], env=self.env, timeout=180)

    def verify_live(self):
        actual = self.containers()
        for service in self.active():
            item = actual.get(service, {})
            demand(item.get("State") == "running" and item.get("Health") in ("", "healthy")
                   and item.get("Image") == self.services[service]["image"], f"Service is not ready on its expected image: {service}")
        for service in ("public-edge", "admin-edge"):
            if service in self.services:
                self.https_health(service)

    def https_health(self, service):
        definition = self.services[service]
        receiving = definition["ports"][0]
        address = receiving["host_ip"]
        if address in ("0.0.0.0", "::"):
            address = "127.0.0.1" if address == "0.0.0.0" else "::1"
        address = f"[{address}]" if ":" in address else address
        published = receiving["published"]
        public = service == "public-edge"
        host = self.settings["PUBLIC_HOST" if public else "ADMIN_HOSTNAME"]
        mount = "public_cert" if public else "admin_cert"
        cert = self.config["secrets"][mount]["file"]
        for route in ("/", "/api/ready"):
            result = call(["curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", "10",
                           "--output", "/dev/null", "--write-out", "%{http_code}",
                           "--cacert", cert, "--resolve", f"{host}:{published}:{address}",
                           f"https://{host}:{published}{route}"], check=False)
            permitted = {b"200"} if public else {b"200", b"403"}
            demand(result.returncode == 0 and result.stdout in permitted, f"HTTPS readiness probe failed: {service}{route}")
        return result.stdout == b"200"

    def containers(self):
        raw = self.compose("ps", "--all", "--format", "json").stdout.decode()
        stripped = raw.lstrip()
        if stripped.startswith("["):
            entries = json.loads(raw)
        else:
            entries = [json.loads(line) for line in raw.splitlines() if line]
        return {entry["Service"]: entry for entry in entries if "-run-" not in entry["Name"]}

    def doctor_network(self, containers):
        ok = True
        for service in self.active():
            item = containers.get(service, {})
            wanted = {self.config["networks"][network]["name"] for network in self.services[service].get("networks", {})}
            if not item.get("ID") or item.get("State") != "running":
                continue
            demand(matches(r"[0-9a-f]{12,64}", item["ID"]), "Invalid container ID in Compose state")
            inspected = call(["docker", "inspect", "--type", "container", "--format",
                              "{{json .NetworkSettings.Networks}}", item["ID"]], check=False)
            actual = set(json.loads(inspected.stdout)) if inspected.returncode == 0 else set()
            if actual != wanted:
                safe_line(f"{service} networks", "ERROR: active attachments differ from Compose")
                ok = False
        safe_line("Docker networks", "OK" if ok and containers else "NOT CHECKED" if ok else "ERROR")
        listeners = self.local_listeners()
        if listeners is None:
            safe_line("Listener conflicts", "NOT CHECKED: ss is unavailable")
            return ok
        collisions = set()
        for service, definition in self.services.items():
            if containers.get(service, {}).get("State") == "running":
                continue
            for mapping in definition.get("ports", []):
                wanted_ip = ipaddress.ip_address(mapping["host_ip"])
                expected_port = int(mapping["published"])
                if any(port == expected_port and addr.version == wanted_ip.version and (
                        addr.is_unspecified or wanted_ip.is_unspecified or addr == wanted_ip) for addr, port in listeners):
                    collisions.add(service)
        safe_line("Listener conflicts", "ERROR: " + ", ".join(sorted(collisions)) if collisions else "OK")
        return ok and not collisions

    @staticmethod
    def local_listeners():
        if not shutil.which("ss"):
            return None
        output = call(["ss", "-H", "-ltn"], check=False)
        if output.returncode:
            return None
        listeners = []
        for row in output.stdout.decode().splitlines():
            words = row.split()
            if len(words) < 5:
                continue
            host, delimiter, port = words[3].rpartition(":")
            if delimiter and port.isdecimal():
                if host == "*":
                    listeners.extend((ipaddress.ip_address(addr), int(port)) for addr in ("0.0.0.0", "::"))
                else:
                    listeners.append((ipaddress.ip_address(host.strip("[]").split("%", 1)[0]), int(port)))
        return listeners

    def doctor_certificates(self):
        ok = True
        known = {"public_cert", "admin_cert", "core_gw_cert", "edge_client_cert", "core_gw_ca", "core_gw_client_ca"}
        for name in sorted(known.intersection(self.config["secrets"])):
            cert = self.config["secrets"][name]["file"]
            valid = call(["openssl", "x509", "-in", cert, "-noout", "-checkend", "0"], check=False)
            fresh = call(["openssl", "x509", "-in", cert, "-noout", "-checkend", str(14 * 86400)], check=False)
            state = "ERROR: expired or inaccessible" if valid.returncode else (
                "WARNING: expires within 14 days" if fresh.returncode else "OK")
            safe_line(name, state)
            ok &= not bool(valid.returncode)
        return ok

    def logical_service(self):
        demand("logical-local" in self.services, "Enable MZT_ENABLE_LOCAL_BACKUP and provision its required secrets")
        return "logical-local"

    def decrypt(self, source, target=None):
        command = self.command + ["run", "-T", "--rm", "--no-deps", "--pull", "never",
                                  self.logical_service()]
        with source.open("rb") as encrypted:
            if target is None:
                call(command + ["verify"], stdin=encrypted, env=self.env, timeout=900, stdout=subprocess.DEVNULL)
                return
            with subprocess.Popen(command + ["decrypt"], stdin=encrypted, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=self.env) as decoded:
                try:
                    self.compose("exec", "-T", "db", "pg_restore", "-U", "postgres", "--role=mzt_migrator",
                                 "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "-d", target,
                                 stdin=decoded.stdout, timeout=1800)
                    decoded.stdout.close()
                    demand(decoded.wait(timeout=30) == 0, "Backup decryption failed")
                finally:
                    if decoded.poll() is None:
                        decoded.kill()


def migration_delta(actual, expected):
    demand(all(expected.get(name) == digest for name, digest in actual.items()) and
           sorted(expected)[:len(actual)] == sorted(actual),
           "PostgreSQL migration checksums or order are incompatible with this release")
    return sorted(expected.keys() - actual.keys())


class Deployment:
    def __init__(self, root=Path("/opt/vpnshop"), binary=Path("/usr/local/bin/vpnshop")):
        self.root, self.binary = root, binary
        self.state = root / "state"
        self.releases = root / "releases"
        self.secrets = root / "secrets"
        self.backups = root / "backups"
        self.config = root / "config/.env"

    @property
    def role(self):
        selected = private_regular(self.state / "role")
        demand(selected in {"single", "core", "edge"}, "Invalid installed role")
        return selected

    def verify_layout(self):
        for directory in (self.root, self.state, self.releases, self.secrets, self.backups, self.config.parent):
            checked_dir(directory)
        demand(self.secrets.stat().st_mode & 0o777 == 0o700, "Secret directory must have mode 0700")
        private_regular(self.config)

    @contextmanager
    def lock(self):
        fd = os.open(self.state / "update.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            demand(stat.S_ISREG(os.fstat(fd).st_mode), "Deployment lock must be a regular file")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ReleaseError("Another VPNShop operation holds the deployment lock") from None
            yield
        finally:
            os.close(fd)

    def pointer(self, name, required=True):
        link = self.root / name
        if not os.path.lexists(link):
            demand(not required, f"Release pointer {name} is missing")
            return None
        demand(link.is_symlink(), "Release pointer is not a controlled symbolic link")
        target = Path(os.readlink(link))
        demand(target.parent == Path("releases"), "Unsafe release pointer")
        location = checked_dir(self.releases / version(target.name))
        demand(manifest(location)[0]["VPNSHOP_VERSION"] == location.name, "Release pointer version differs from manifest")
        return location

    def switch(self, name, release):
        demand(release == self.releases / version(release.name), "Invalid installed release path")
        tmp = self.root / ("." + name + ".new")
        tmp.unlink(missing_ok=True)
        tmp.symlink_to(Path("releases") / release.name)
        os.replace(tmp, self.root / name)
        sync_directory(self.root)

    def install(self, selection, role, source, *, pinned=None, attest=False):
        checked_dir(self.root.parent)
        checked_dir(self.binary.parent)
        lock_path = self.root.parent / (self.root.name + ".install.lock")
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as lock:
            demand(stat.S_ISREG(os.fstat(fd).st_mode), "Install lock must be a regular file")
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ReleaseError("Another VPNShop installation is being prepared") from None
            demand(not os.path.lexists(self.root) and not os.path.lexists(self.binary),
                   "VPNShop installation or CLI already exists. Use up, update or the documented legacy cutover.")
            with tempfile.TemporaryDirectory(prefix=".install-", dir=self.root.parent) as tmp:
                directory = Path(tmp)
                tag, archive = source.fetch(selection, directory, pinned=pinned, attest=attest)
                staged = directory / "release"
                staged.mkdir()
                values, _, _ = unpack(archive, staged)
                demand(values["VPNSHOP_VERSION"] == tag, "Archive and release version differ")
                self.check_existing_project(role)
                new = type(self)(directory / "layout", self.binary)
                for item in (new.root, new.state, new.releases, new.secrets, new.config.parent, new.backups):
                    item.mkdir(mode=0o700)
                release = new.releases / tag
                os.replace(staged, release)
                atomic(new.config, (release / f"templates/env.{role}.example").read_bytes())
                atomic(new.state / "role", (role + "\n").encode())
                new.generate(role, release)
                new.switch("current", release)
                new.log("install", None, tag, "prepared")
                os.replace(new.root, self.root)
                sync_directory(self.root.parent)
                self.copy_cli(self.releases / tag)
                notify(f"Installed {tag} for {role}. Complete config/.env and provision applicable operator secret files before vpnshop up.")
                for line in (self.releases / tag / "templates/secrets.list").read_text().splitlines():
                    if line and not line.startswith("#"):
                        name, roles, condition, origin, *_ = line.split("|")
                        if role in roles.split(",") and origin == "operator" and condition != "reserved":
                            safe_line(name, condition)

    def check_existing_project(self, role):
        label = f"label=com.docker.compose.project=vpnshop-{role}"
        for object_type in ("container", "volume", "network"):
            output = call(["docker", object_type, "ls", "--quiet", "--filter", label]).stdout
            demand(not output.strip(), "Existing Compose resources require a separately rehearsed migration")
        if role != "edge":
            volumes = call(["docker", "volume", "ls", "--quiet", "--filter", "label=com.docker.compose.volume=pgdata"]).stdout.decode()
            demand(not any(re.search(r"(?i)(mzt|vpn[-_]?shop)", name) for name in volumes.splitlines()),
                   "A legacy PostgreSQL volume requires a separately rehearsed migration")

    def generate(self, role, release):
        api = module(release / "scripts/preflight.py")
        image = manifest(release)[0]["EDGE_IMAGE"]
        if role == "edge":
            return
        options = call(["docker", "info", "--format", "{{json .SecurityOptions}}"]).stdout.decode()
        if "rootless" in options or "userns" in options:
            call(["docker", "pull", image], timeout=900)
        ownership = api.host_ownership(image, os.environ)
        settings = api.read_settings(self.config)
        for name, roles, condition, origin, fmt, uid, mode, _ in api.schema_inventory():
            needed = condition == "always" or condition == "backup" and any(
                settings.get(flag) == "1" for flag in ("MZT_ENABLE_OFFSITE", "MZT_ENABLE_LOCAL_BACKUP"))
            path = self.secrets / name
            if role not in roles.split(",") or origin != "generated" or not needed or os.path.lexists(path):
                continue
            if fmt == "postgres-url":
                pg_role = name.removesuffix("_url")
                secret = (self.secrets / ("db_" + pg_role)).read_text().strip()
                alias = "migrate" if pg_role == "migrator" else pg_role
                value = f"postgresql://mzt_{pg_role}:{parse.quote(secret, safe='')}@pg-{alias}:5432/vpnshop"
            elif fmt == "base64-32":
                value = base64.b64encode(random.token_bytes(32)).decode()
            else:
                value = random.token_urlsafe(48)
            atomic(path, (value + "\n").encode(), int(mode, 8))
            os.chown(path, *map(int, ownership(uid).split(":")))

    def copy_cli(self, release):
        atomic(self.binary, (release / "vpnshop.sh").read_bytes(), 0o755)

    def monitoring_path(self, release, create):
        source = release / "monitoring"
        digest = tree_id({file.name: digest_file(file) for file in sorted(source.iterdir()) if file.is_file()})
        target = self.state / ("monitoring-" + digest.removeprefix("sha256:"))
        if create and not target.exists():
            with tempfile.TemporaryDirectory(dir=self.state) as staging:
                copy = Path(staging) / "monitoring"
                shutil.copytree(source, copy)
                copy.chmod(0o755)
                os.replace(copy, target)
                sync_directory(self.state)
        return target

    def read_pending(self):
        path = self.state / "pending-update"
        if not path.exists():
            return None
        value = json.loads(private_regular(path))
        demand(value["operation"] in {"update", "rollback", "restore"} and isinstance(value["phase"], str),
               "Invalid pending operation; operator inspection required")
        for key in ("source", "target"):
            version(value[key])
        return value

    def set_pending(self, value, phase):
        value["phase"] = phase
        atomic(self.state / "pending-update", (json.dumps(value, sort_keys=True) + "\n").encode())

    def completed(self, operation, release, former=None, backup=None, changed=()):
        if former:
            self.switch("previous", former)
        atomic(self.state / "last-successful-release", (release.name + "\n").encode())
        if self.role != "edge":
            atomic(self.state / "applied-migration-tree", (manifest(release)[0]["MIGRATION_TREE"] + "\n").encode())
        self.log(operation, former.name if former else release.name, release.name, "ok", backup, changed)

    def log(self, operation, source, target, result, backup=None, changed=(), reason=None):
        entry = {"at": clock().isoformat(), "operation": operation, "from": source, "to": target,
                 "result": result, "backup": backup, "changed": list(changed), "reason": reason}
        fd = os.open(self.state / "history.log", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as output:
            output.write(json.dumps(entry, sort_keys=True) + "\n")
            output.flush()
            os.fsync(output.fileno())

    def stage(self, selection, source, directory, args):
        tag, archive = source.fetch(selection, directory, pinned=args.sha256, attest=args.attest)
        staged = directory / "release"
        staged.mkdir()
        unpack(archive, staged)
        demand(manifest(staged)[0]["VPNSHOP_VERSION"] == tag, "Archive and release version differ")
        return staged, tag

    def retain(self, staged, tag):
        dest = self.releases / version(tag)
        if dest.exists():
            checked_dir(dest)
            def identities(root):
                return {str(path.relative_to(root)): digest_file(path) for path in root.rglob("*") if path.is_file()}
            demand(identities(dest) == identities(staged), "That release version already has different contents")
        else:
            os.replace(staged, dest)
            sync_directory(self.releases)
        return dest

    def prune(self):
        protected = {item.name for name in ("current", "previous")
                     if (item := self.pointer(name, required=False))}
        pending = self.read_pending()
        if pending:
            protected.update((pending["source"], pending["target"]))
        last = self.state / "last-successful-release"
        if last.exists():
            protected.add(version(private_regular(last)))
        candidates = [item for item in self.releases.iterdir()
                      if item.is_dir() and not item.is_symlink() and matches(r"v[0-9]+\.[0-9]+\.[0-9]+", item.name)]
        order = sorted(candidates, key=lambda item: tuple(map(int, item.name[1:].split("."))), reverse=True)
        protected.update(item.name for item in order[:3])
        for item in order:
            if item.name not in protected:
                shutil.rmtree(checked_dir(item))

    def min_space(self, need=1024 * 1024 * 1024):
        demand(shutil.disk_usage(self.root).free >= need, "Insufficient free space for the operation")

    def up(self):
        release = self.pointer("current")
        runtime = Runtime(self, release, allow_pull=True)
        if self.role != "edge":
            runtime.start("db")
            actual, _, _ = runtime.inventory()
            if actual and actual != runtime.history:
                raise ReleaseError("Existing PostgreSQL schema differs from current. Use the update or recovery command.")
            if not actual:
                demand(not (self.state / "last-successful-release").exists(),
                       "Previously initialized installation has no migration history. Inspect the PostgreSQL volume.")
            runtime.migrate()
        runtime.start()
        runtime.verify_live()
        self.completed("up", release)
        notify("Deployment is ready.")

    def backup(self, runtime, *, offsite=True):
        demand(self.role != "edge", "This Edge has no local PostgreSQL database")
        local = runtime.logical_service()
        schema, size, pg = runtime.inventory()
        demand(schema == runtime.history, "Backup migration history differs from current release")
        self.min_space(max(2 * size, 128 * 1024 * 1024))
        tag = clock().strftime("%Y%m%dT%H%M%SZ") + "-" + random.token_hex(6)
        with tempfile.TemporaryDirectory(prefix=".backup-", dir=self.backups) as tmp:
            staged = Path(tmp) / tag
            staged.mkdir(mode=0o700)
            encrypted = staged / "dump.gpg"
            with encrypted.open("xb") as stream:
                runtime.compose("run", "-T", "--rm", "--no-deps", "--pull", "never", local, "export", stdout=stream, timeout=900)
                stream.flush()
                os.fsync(stream.fileno())
            demand(encrypted.stat().st_size > 0, "Backup produced no verified encrypted archive")
            if offsite and "logical" in runtime.services:
                runtime.compose("run", "-T", "--rm", "--no-deps", "--pull", "never", "logical", timeout=900)
            details = {"createdAt": clock().isoformat(), "release": runtime.release.name, "postgresVersion": pg,
                       "migrationTree": tree_id(schema), "format": "pgdump-custom+gpg-aes256", "databaseBytes": size,
                       "keyVersion": runtime.settings.get("LOGICAL_KEY_VERSION") or "local",
                       "sha256": digest_file(encrypted), "verified": "checksum-decryption-toc",
                       "offsite": bool(offsite and "logical" in runtime.services)}
            atomic(staged / "metadata.json", (json.dumps(details, sort_keys=True) + "\n").encode())
            os.replace(staged, self.backups / tag)
            sync_directory(self.backups)
        self.log("backup", runtime.release.name, runtime.release.name, "ok", tag)
        safe_line("Verified backup", tag)
        return tag

    def backup_record(self, tag, runtime):
        demand(matches(BACKUP_ID, tag), "Expected a VPNShop backup ID")
        folder = checked_dir(self.backups / tag)
        encrypted = folder / "dump.gpg"
        info = json.loads(private_regular(folder / "metadata.json"))
        demand(not encrypted.is_symlink() and encrypted.is_file() and
               info["format"] == "pgdump-custom+gpg-aes256" and info["sha256"] == digest_file(encrypted)
               and info["postgresVersion"] // 10000 == POSTGRES_MAJOR
               and info["migrationTree"] == runtime.values["MIGRATION_TREE"]
               and info["verified"] == "checksum-decryption-toc"
               and info["keyVersion"] == (runtime.settings.get("LOGICAL_KEY_VERSION") or "local"),
               "Backup integrity, PostgreSQL version, key or migration history is incompatible")
        return encrypted, info

    def update(self, args, source):
        former = self.pointer("current")
        with tempfile.TemporaryDirectory(prefix=".candidate-", dir=self.root) as tmp:
            staged, tag = self.stage(args.selection, source, Path(tmp), args)
            current = Runtime(self, former, read_only=True)
            candidate = Runtime(self, staged, read_only=True)
            changes = [name for name, key in IMAGE_KEYS.items() if current.values[key] != candidate.values[key]]
            additions = migration_delta(current.history, candidate.history)
            schema_changes = bool(additions) and self.role != "edge"
            database_change = "db" in changes and self.role != "edge"
            if schema_changes or database_change:
                current.logical_service()
            if self.role != "edge":
                live = current.containers().get("db", {}).get("State")
                demand(live == "running", "Start the database before planning an update")
                actual, size, _ = current.inventory()
                demand(actual == current.history, "Database migration history differs from current")
                self.min_space(max(3 * size, 1024 * 1024 * 1024))
            else:
                self.min_space()
            safe_line("Current → candidate", f"{former.name} → {tag}")
            safe_line("Changed images", ", ".join(changes) or "none")
            safe_line("Unchanged images", ", ".join(name for name in IMAGE_KEYS if name not in changes) or "none")
            safe_line("Pending migrations", ", ".join(additions) if schema_changes else "none for this role")
            safe_line("Maintenance", "writer drain and verified backup" if schema_changes or database_change else "Compose reconciles changed services")
            safe_line("Core/Edge rollout", candidate.metadata["coordination"])
            if schema_changes:
                safe_line("Rollback", "requires an exact compatible migration history")
            if args.dry_run:
                safe_line("Secret ownership", candidate.check_owners_read_only())
            notes = (staged / "NOTES.md").read_text()
            # Only release notes, with terminal control characters removed.
            print("".join(c for c in notes if c in "\n\t" or 32 <= ord(c) < 127 or ord(c) > 159), flush=True)
            if tag == former.name:
                self.retain(staged, tag)
                notify("Current release matches the candidate.")
                return
            demand(tuple(map(int, tag[1:].split("."))) > tuple(map(int, former.name[1:].split("."))),
                   "Use rollback for a previous release")
            if args.dry_run:
                notify("Dry run complete. Registry pulls and deployment changes were skipped.", "33")
                return
            # Pull only after the candidate and current database are proven compatible.
            candidate.ensure_images()
            candidate.validate_owners()
            ask("Type yes to apply this update.", yes=args.yes)
            if schema_changes or database_change:
                ask("Database changes may require a forward fix or restore. Type the target release to authorize.",
                    phrase=tag)
            if candidate.metadata["coordination"] == "coordinated" and self.role != "single":
                ask("Follow the coordinated Core/Edge sequence in NOTES.md. Type the target release to continue.",
                    phrase=tag)
            self.retain(staged, tag)
            pending = {"operation": "update", "source": former.name, "target": tag, "backup": None,
                       "startedAt": clock().isoformat(), "migrations": additions if schema_changes else [],
                       "databaseImageChange": database_change, "changed": changes, "switched": False}
            self.set_pending(pending, "prepared")
            self.resume_update(pending)

    def rollback(self, args):
        former, target = self.pointer("current"), self.pointer("previous")
        current = Runtime(self, former, read_only=True)
        candidate = Runtime(self, target, allow_pull=True)
        changed = [name for name, key in IMAGE_KEYS.items() if current.values[key] != candidate.values[key]]
        if self.role != "edge":
            demand(current.inventory()[0] == candidate.history, "Rollback is incompatible with the applied PostgreSQL migration history")
            demand("db" not in changed, "Rollback across a PostgreSQL image change requires a separate recovery plan")
        safe_line("Rollback", f"{former.name} → {target.name}")
        safe_line("Changed images", ", ".join(changed) or "none")
        if candidate.metadata["coordination"] == "coordinated" and self.role != "single":
            ask("Confirm the rollback order in NOTES.md by typing the previous release.", phrase=target.name)
        ask("Type yes to roll back.", yes=args.yes)
        pending = {"operation": "rollback", "source": former.name, "target": target.name, "backup": None,
                   "startedAt": clock().isoformat(), "migrations": [], "databaseImageChange": False,
                   "changed": changed, "switched": False}
        self.set_pending(pending, "prepared")
        self.resume_update(pending)

    def resume_update(self, pending):
        former, target = (checked_dir(self.releases / pending[key]) for key in ("source", "target"))
        selected = self.pointer("current")
        demand(selected in (former, target), "Current pointer no longer matches pending update")
        candidate = Runtime(self, target, allow_pull=True)
        schema_change = bool(pending["migrations"])
        db_change = pending["databaseImageChange"]
        if self.role != "edge":
            current = Runtime(self, former)
            if schema_change or db_change:
                if not pending["backup"]:
                    current.stop_writers()
                    self.set_pending(pending, "drained")
                    pending["backup"] = self.backup(current)
                # Recheck the original backup before retrying or moving past any database step.
                self.backup_record(pending["backup"], current)
                if selected == former:
                    self.set_pending(pending, "migrating")
                    candidate.start("db")
                    candidate.migrate()
                else:
                    demand(candidate.inventory()[0] == candidate.history, "Pending update schema does not match the candidate")
            else:
                demand(candidate.inventory()[0] == candidate.history, "Target is incompatible with the applied PostgreSQL migration history")
        if selected != target:
            self.switch("current", target)
        pending["switched"] = True
        self.set_pending(pending, "starting")
        candidate.start()
        candidate.verify_live()
        self.copy_cli(target)
        self.completed(pending["operation"], target, former, pending["backup"], pending["changed"])
        self.finish_pending()
        self.prune()
        notify(f"Deployment is ready on {target.name}.")

    def finish_pending(self):
        (self.state / "pending-update").unlink()
        sync_directory(self.state)

    def restore(self, tag):
        demand(self.role != "edge", "This Edge has no local PostgreSQL database")
        release = self.pointer("current")
        target = Runtime(self, release, allow_pull=True)
        demand("panel" not in target.flags, "Disable panel egress before restoring a database")
        encrypted, info = self.backup_record(tag, target)
        schema, size, pg = target.inventory()
        demand(schema == target.history and pg >= info["postgresVersion"],
               "Restore requires the active PostgreSQL version and migration history to match the backup")
        self.min_space(max(4 * size, 4 * info["databaseBytes"], 1024 * 1024 * 1024))
        target.decrypt(encrypted)
        safe_line("Restore backup", tag)
        safe_line("Backup time and release", f"{info['createdAt']} · {info['release']}")
        ask("RESTORE replaces the active dataset. Newer records may be lost. Type the backup ID to confirm.", phrase=tag)
        old = target.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres")
        demand(matches(r"[0-9]+", old), "Active database identity is unavailable")
        serial = random.token_hex(6)
        pending = {"operation": "restore", "source": release.name, "target": release.name, "backup": tag,
                   "startedAt": clock().isoformat(), "migrations": [], "switched": False, "oldOid": old,
                   "scratch": "mzt_restore_" + serial, "retained": "mzt_retained_" + serial, "safetyBackup": None}
        self.set_pending(pending, "prepared")
        self.resume_restore(pending)

    def resume_restore(self, pending):
        release = self.pointer("current")
        demand(release.name == pending["source"], "Current release no longer matches the restore")
        runtime = Runtime(self, release, allow_pull=True)
        demand("panel" not in runtime.flags, "Disable panel egress before continuing restore")
        encrypted, info = self.backup_record(pending["backup"], runtime)
        scratch, retained, old_oid = (pending[key] for key in ("scratch", "retained", "oldOid"))
        demand(matches(r"mzt_restore_[0-9a-f]{12}", scratch) and matches(r"mzt_retained_[0-9a-f]{12}", retained)
               and matches(r"[0-9]+", old_oid), "Unsafe restore state")
        actual = runtime.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres")
        if actual != old_oid:
            new_oid = pending.get("newOid")
            demand(matches(r"[0-9]+", new_oid) and actual == new_oid
                   and runtime.sql(f"SELECT oid FROM pg_database WHERE datname='{retained}' AND NOT datallowconn;", "postgres") == old_oid,
                   "Database identity cannot be reconciled. Leave writers stopped and inspect PostgreSQL.")
        else:
            runtime.stop_writers()
            if not pending["safetyBackup"]:
                pending["safetyBackup"] = self.backup(runtime, offsite=False)
                self.set_pending(pending, "restore-stopped")
            self.backup_record(pending["safetyBackup"], runtime)
            self.min_space(max(4 * info["databaseBytes"], 1024 * 1024 * 1024))
            # Unique, journaled scratch DB. Recreating it is safe because its OID cannot equal the active database.
            demand(not runtime.sql(f"SELECT 1 FROM pg_database WHERE datname='{scratch}' AND oid={old_oid};", "postgres"),
                   "Scratch database identity conflict")
            runtime.sql(f"DROP DATABASE IF EXISTS {scratch} WITH (FORCE);", "postgres")
            runtime.sql(f"CREATE DATABASE {scratch} WITH OWNER mzt_migrator TEMPLATE template0;", "postgres")
            runtime.sql(f"REVOKE ALL ON DATABASE {scratch} FROM PUBLIC;", "postgres")
            self.set_pending(pending, "restoring-scratch")
            runtime.decrypt(encrypted, scratch)
            demand(runtime.inventory(scratch)[0] == runtime.history, "Restored migration history differs from current")
            runtime.sql("SET ROLE mzt_migrator;\n" + (release / "db/grants.sql").read_text(), scratch)
            runtime.sql((release / "backup/prepare-restored.sql").read_text(), scratch,
                        exec_args=("-e", "MZT_ISOLATED_RESTORE=" + MARKER))
            runtime.sql(f"GRANT CONNECT ON DATABASE {scratch} TO mzt_public,mzt_admin,mzt_worker,mzt_billing,"
                        "mzt_notifications,mzt_backup,mzt_monitor;", "postgres")
            pending["newOid"] = runtime.sql(f"SELECT oid FROM pg_database WHERE datname='{scratch}';", "postgres")
            self.set_pending(pending, "swap-prepared")
            # One transaction changes both database names and disables connections to the retained dataset.
            runtime.sql(f"""BEGIN;
                ALTER DATABASE vpnshop WITH ALLOW_CONNECTIONS false;
                SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE datname='vpnshop';
                ALTER DATABASE vpnshop RENAME TO {retained};
                ALTER DATABASE {scratch} RENAME TO vpnshop;
                COMMIT;""", "postgres")
        demand(runtime.inventory()[0] == runtime.history, "Restored active schema failed verification")
        pending["switched"] = True
        self.set_pending(pending, "restore-starting")
        runtime.start()
        runtime.verify_live()
        self.completed("restore", release, backup=pending["backup"])
        self.finish_pending()
        safe_line("Previous database retained", retained)
        notify("Restored deployment is ready.")

    def recover(self, args):
        pending = self.read_pending()
        demand(pending, "No interrupted deployment operation")
        safe_line("Pending operation", f"{pending['operation']} {pending['source']} → {pending['target']}")
        safe_line("Phase", pending["phase"])
        if args.cancel:
            demand(not pending["switched"] and self.pointer("current").name == pending["source"],
                   "Cannot cancel after a release switch. Resume or use documented recovery.")
            release = self.pointer("current")
            runtime = Runtime(self, release, allow_pull=True)
            if self.role != "edge":
                demand(runtime.inventory()[0] == runtime.history, "Cannot cancel after a database migration")
                if pending["operation"] == "restore":
                    original = runtime.sql("SELECT oid FROM pg_database WHERE datname='vpnshop';", "postgres")
                    demand(original == pending["oldOid"], "Cannot cancel after the restore database swap")
                if pending.get("databaseImageChange") and pending["phase"] == "migrating":
                    raise ReleaseError("Database image rollout may have started. Resume or use the recovery runbook.")
            ask("Type yes to cancel and start the original release.", yes=args.yes)
            runtime.start()
            runtime.verify_live()
            self.log("cancel-" + pending["operation"], release.name, pending["target"], "ok")
            self.finish_pending()
        else:
            if pending["operation"] == "restore":
                # Restore confirmation remains separate even when resuming a journaled operation.
                ask("Type the approved backup ID to resume restore.", phrase=pending["backup"])
                self.resume_restore(pending)
            else:
                ask("Type yes to resume the recorded operation.", yes=args.yes)
                self.resume_update(pending)

    def status(self, *, doctor=False):
        release = self.pointer("current")
        previous = self.pointer("previous", required=False)
        values, history, _ = manifest(release)
        safe_line("Release", release.name)
        safe_line("Role", self.role)
        safe_line("Git SHA", values["GIT_SHA"])
        safe_line("Previous", previous.name if previous else "none")
        last = self.state / "last-successful-release"
        safe_line("Last successful", private_regular(last) if last.exists() else "none")
        pending = self.read_pending()
        safe_line("Pending", (pending["operation"] + " · " + pending["phase"]) if pending else "none")
        safe_line("Disk free (MiB)", shutil.disk_usage(self.root).free // (1024 * 1024))
        backups = sorted(path.name for path in self.backups.iterdir() if matches(BACKUP_ID, path.name))
        safe_line("Last backup", backups[-1] if backups else "none")
        history_log = self.state / "history.log"
        if history_log.exists():
            with history_log.open("rb") as stream:
                stream.seek(max(0, history_log.stat().st_size - 4096))
                lines = stream.read().splitlines()
            if lines:
                event = json.loads(lines[-1])
                safe_line("Last operation", f"{event['operation']} · {event['result']} · {event['at']}")
        if doctor:
            for tool in ("docker", "curl", "tar", "sha256sum", "openssl", "flock", "python3"):
                safe_line(tool, "OK" if shutil.which(tool) else "ERROR")
            call(["docker", "version", "--format", "{{.Server.Version}}"])
            call(["docker", "compose", "version"])
            safe_line("Docker/Compose", "OK")
        try:
            runtime = Runtime(self, release, read_only=True)
        except (ReleaseError, OSError, ValueError) as problem:
            safe_line("Status", "ERROR: deployment configuration or dependencies unavailable")
            raise problem
        safe_line("Config/TLS/secret modes", "OK")
        safe_line("UID availability", "NOT CHECKED" if not doctor else runtime.check_owners_read_only())
        safe_line("Link", runtime.settings.get("LINK_MODE", "internal"))
        access = runtime.settings.get("ADMIN_ACCESS_MODE", "NOT CONFIGURED")
        safe_line("Admin access", access)
        if self.role != "edge":
            policy = runtime.settings["ADMIN_2FA_POLICY"]
            safe_line("Admin 2FA policy", policy)
            if access == "public" and policy == "disabled":
                safe_line("Admin 2FA", "WARNING: public administration with 2FA disabled")
        listed = runtime.containers()
        good = not pending
        for service in runtime.active():
            item = listed.get(service, {})
            healthy = item.get("State") == "running" and item.get("Health") in ("", "healthy")
            expected = runtime.services[service]["image"]
            actual = item.get("Image", "NOT CHECKED")
            good &= healthy and actual == expected
            safe_line(service, f"{item.get('State', 'missing')} {item.get('Health', '')}".strip())
            safe_line("  expected", expected)
            safe_line("  actual", actual + ("  DIFFERS" if actual != expected else ""))
        extras = sorted(listed.keys() - runtime.services.keys())
        if extras:
            safe_line("Unconfigured services", ", ".join(extras))
            good = False
        if self.role != "edge":
            try:
                actual = runtime.inventory()[0]
                safe_line("PostgreSQL migrations", tree_id(actual) if actual == history else "ERROR: history differs")
                good &= actual == history
            except ReleaseError:
                safe_line("PostgreSQL migrations", "NOT CHECKED")
                good = False
            if backups:
                try:
                    self.backup_record(backups[-1], runtime)
                    safe_line("Backup compatibility", "OK")
                except ReleaseError:
                    safe_line("Backup compatibility", "WARNING: last backup is incompatible or damaged")
        if doctor:
            network_ok = runtime.doctor_network(listed)
            good = runtime.doctor_certificates() and network_ok and good
            if self.role == "core" and runtime.settings.get("LINK_MODE") == "public":
                safe_line("Remote mTLS peer", "NOT CHECKED: run doctor on the configured Edge")
            for service in ("public-edge", "admin-edge"):
                if service not in runtime.services:
                    continue
                try:
                    routed = runtime.https_health(service)
                    safe_line(f"{service} HTTPS", "OK" if routed else "OK: TLS; application blocked for this host by ACL")
                except ReleaseError:
                    safe_line(f"{service} HTTPS", "ERROR or NOT CHECKED: endpoint unavailable from this host")
                    good = False
        safe_line("Status", "healthy" if good else "WARNING: incomplete or degraded")
        return 0 if good else 1

    def local_admin(self, args):
        demand(self.role != "edge", "Administrative identity commands are available on Single and Core only")
        release = self.pointer("current")
        runtime = Runtime(self, release)
        demand(runtime.inventory()[0] == runtime.history, "Run vpnshop up and verify PostgreSQL migrations first")
        operation = args.admin_action
        data = {}
        if operation != "list":
            username = args.username
            if not username:
                with open("/dev/tty", "r+", encoding="utf-8") as terminal:
                    terminal.write("Staff username: ")
                    terminal.flush()
                    username = terminal.readline().rstrip("\r\n")
            demand(matches(r"[a-zA-Z0-9][a-zA-Z0-9._-]{2,47}", username), "Invalid staff username")
            username = username.lower()
            data = {"username": username, "correlationId": str(uuid4())}
            if operation == "bootstrap":
                fields = {"displayName": args.display_name, "contactEmail": args.contact_email}
                data.update({key: value for key, value in fields.items() if value})
            else:
                demand(matches(r"[A-Za-z0-9][A-Za-z0-9._-]{4,79}", args.incident), "Provide a nonsecret incident ID")
                demand(not args.adopt_legacy_owner or not (args.password_stdin or args.password_file or args.reset_totp or args.restore_status),
                       "Legacy promotion preserves credentials and status. Omit password and reset flags.")
                confirmation = args.confirm_username
                if confirmation is None:
                    ask(f"This action changes administrative access for {username}. Type the username to confirm.", phrase=username)
                else:
                    demand(confirmation == username, "Recovery confirmation must match the username")
                data["incident"] = args.incident
                if args.adopt_legacy_owner:
                    operation = "adopt-legacy-owner"
                else:
                    data.update(resetTotp=args.reset_totp, restoreStatus=args.restore_status)
            if operation != "adopt-legacy-owner":
                if args.password_file:
                    password = private_regular(args.password_file)
                elif args.password_stdin:
                    password = sys.stdin.readline(4097).removesuffix("\n").removesuffix("\r")
                    demand(not sys.stdin.read(1), "Provide a single password line")
                else:
                    with open("/dev/tty", "r+", encoding="utf-8") as terminal:
                        password = getpass.getpass("New password (12–128 characters): ", stream=terminal)
                        demand(password == getpass.getpass("Confirm password: ", stream=terminal), "Passwords differ")
                demand(12 <= len(password) <= 128 and not any(ord(ch) < 32 for ch in password), "Invalid password length or format")
                data["password"] = password
        response = runtime.compose("run", "-T", "--rm", "--no-deps", "--pull", "never", "--entrypoint", "node",
                                   "admin-api", "dist/admin-local.js", operation, input=json.dumps(data).encode(), check=False)
        codes = {"STAFF_ALREADY_INITIALIZED", "OWNER_NOT_FOUND", "OWNER_ALREADY_EXISTS", "LEGACY_ADMIN_NOT_ELIGIBLE",
                 "STAFF_USERNAME_IN_USE", "INVALID_LOCAL_INPUT"}
        if response.returncode:
            reason = next((line for line in response.stderr.decode(errors="replace").splitlines() if line in codes), "LOCAL_ADMIN_FAILED")
            raise ReleaseError(reason)
        result = json.loads(response.stdout)
        if operation == "list":
            for row in result:
                safe_line(row["username"], f"{row['role']} · {row['status']} · {row['id']} · {row['contactEmail'] or '—'}")
        else:
            self.log("admin-" + operation, release.name, release.name, "ok", reason=data["correlationId"])
            safe_line("Staff account", result["username"])
            notify("Administrative command committed. Existing sessions are revoked where applicable.")

    def service_operation(self, operation, service=None):
        runtime = Runtime(self, self.pointer("current"))
        if service:
            demand(service in runtime.active(), "Unknown or inactive service")
        if operation == "down":
            runtime.compose("down", "--timeout", "120", timeout=260)
        else:
            if service:
                runtime.compose("restart", "--timeout", "120", service, timeout=260)
                runtime.start(service)
            else:
                runtime.compose("stop", "--timeout", "120", timeout=260)
                self.up()
            runtime.verify_live()
        self.log(operation, runtime.release.name, runtime.release.name, "ok")


def parser():
    result = argparse.ArgumentParser(prog="vpnshop", description="MZT / VPNSHOP deployment CLI")
    commands = result.add_subparsers(dest="command", required=True)
    add = commands.add_parser
    for name in ("install", "update"):
        command = add(name)
        command.add_argument("selection", metavar="version|latest")
        command.add_argument("--github-token-file", type=Path)
        command.add_argument("--sha256", metavar="ARCHIVE_SHA256")
        command.add_argument("--attest", action="store_true", help="require GitHub Actions provenance verification")
        if name == "install":
            command.add_argument("--role", required=True, choices=["single", "core", "edge"])
        else:
            command.add_argument("--yes", action="store_true")
            command.add_argument("--dry-run", action="store_true")
    for name in ("rollback", "recover"):
        command = add(name)
        command.add_argument("--yes", action="store_true")
        if name == "recover":
            command.add_argument("--cancel", action="store_true")
    for name in ("up", "down", "status", "doctor", "backup", "version", "help"):
        add(name)
    add("restart").add_argument("service", nargs="?")
    add("restore").add_argument("backup")
    add("compose").add_argument("compose_args", nargs=argparse.REMAINDER)
    admin = add("admin").add_subparsers(dest="admin_action", required=True)
    admin.add_parser("list")
    for name in ("bootstrap", "recover"):
        command = admin.add_parser(name)
        command.add_argument("--username")
        credentials = command.add_mutually_exclusive_group()
        credentials.add_argument("--password-stdin", action="store_true")
        credentials.add_argument("--password-file", type=Path)
        if name == "bootstrap":
            command.add_argument("--display-name")
            command.add_argument("--contact-email")
        else:
            command.add_argument("--incident", required=True)
            command.add_argument("--confirm-username")
            command.add_argument("--reset-totp", action="store_true")
            command.add_argument("--restore-status", action="store_true")
            command.add_argument("--adopt-legacy-owner", action="store_true")
    return result


def execute(args, deployment, source_factory=ReleaseSource):
    if args.command == "version":
        current = deployment.pointer("current", required=False)
        print(f"vpnshop CLI 2 (PASS 02) · {current.name if current else 'not installed'}")
        return 0
    if args.command == "install":
        if args.selection != "latest":
            version(args.selection)
        deployment.install(args.selection, args.role, source_factory(args.github_token_file), pinned=args.sha256, attest=args.attest)
        return 0
    deployment.verify_layout()
    if args.command == "admin" and args.admin_action == "list":
        deployment.local_admin(args)
        return 0
    if args.command in {"status", "doctor"}:
        notify("MZT / VPNSHOP", "35")
        return deployment.status(doctor=args.command == "doctor")
    with deployment.lock():
        try:
            return mutate(args, deployment, source_factory)
        except (ReleaseError, OSError, ValueError, subprocess.TimeoutExpired) as problem:
            if args.command != "compose" and not getattr(args, "dry_run", False):
                pending = deployment.read_pending()
                source = deployment.pointer("current", required=False)
                deployment.log(args.command, pending["source"] if pending else source.name if source else None,
                               pending["target"] if pending else None, "failed",
                               pending.get("backup") if pending else None,
                               pending.get("changed", ()) if pending else (), reason=type(problem).__name__)
            raise


def mutate(args, deployment, source_factory):
    if args.command == "recover":
        deployment.recover(args)
        return 0
    demand(not deployment.read_pending(), "An operation is interrupted. Run vpnshop status and vpnshop recover.")
    current = deployment.pointer("current")
    if args.command == "admin":
        deployment.local_admin(args)
    elif args.command == "up":
        deployment.up()
    elif args.command in {"down", "restart"}:
        deployment.service_operation(args.command, getattr(args, "service", None))
    elif args.command == "update":
        deployment.update(args, source_factory(args.github_token_file))
    elif args.command == "rollback":
        deployment.rollback(args)
    elif args.command == "backup":
        demand(deployment.role != "edge", "This Edge has no local PostgreSQL database")
        deployment.backup(Runtime(deployment, current, allow_pull=True))
    elif args.command == "restore":
        deployment.restore(args.backup)
    elif args.command == "compose":
        command = args.compose_args
        # Expose a bounded operator view. Workload mutations go through the recovery-aware commands.
        read_commands = {"ps", "top", "images", "port"}
        demand(command and (command[0] in read_commands or command == ["config", "--services"]) and
               not any(arg.startswith(("--env", "--file", "--project")) or arg in ("-f", "-p") for arg in command[1:]),
               "Use compose ps, top, images, port or config --services. Workload changes use the VPNShop lifecycle commands.")
        Runtime(deployment, current, read_only=True).compose(*command, stdout=None)
    return 0


def main(argv=None):
    cli = parser()
    args = cli.parse_args(argv)
    if args.command == "help":
        cli.print_help()
        return 0
    if args.command != "version":
        demand(os.geteuid() == 0, "Run administrative VPNShop commands with sudo/root")
        for name in ("docker", "curl", "tar", "sha256sum", "openssl", "flock"):
            demand(shutil.which(name), f"Required tool is unavailable: {name}")
    return execute(args, Deployment())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ReleaseError as problem:
        sys.exit(f"MZT / VPNSHOP · ERROR · {problem}")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError, subprocess.TimeoutExpired):
        sys.exit("MZT / VPNSHOP · ERROR · Invalid installation state, inaccessible data or operation timed out.")
    except Exception as problem:
        if type(problem).__module__ == "vpnshop_preflight" and type(problem).__name__ == "Invalid":
            sys.exit(f"MZT / VPNSHOP · PREFLIGHT · {problem}")
        raise
