#!/usr/bin/env python3
"""Render the V2 deployment matrix with disposable paths and synthetic credentials."""
import base64
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import unittest
from tempfile import TemporaryDirectory
from urllib.parse import quote

import preflight

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "ops/scripts/preflight.py"
ADMIN = {
    "PUBLIC_ORIGIN": "https://shop.example.test",
    "ADMIN_HOSTNAME": "admin.example.test",
    "ADMIN_ORIGIN": "https://admin.example.test",
    "ADMIN_BIND_IP": "10.90.0.5",
    "ADMIN_CLIENT_CIDRS": "10.90.0.0/24",
}
STOREFRONT = {"PUBLIC_HOST": "shop.example.test"}
CONFIG = {
    ("single", "private"): ADMIN | STOREFRONT,
    ("core", "private"): ADMIN | {"CORE_LISTEN_IP": "100.92.0.1", "EDGE_PEER_IP": "100.92.0.2"},
    ("edge", "private"): STOREFRONT | {"CORE_API_ADDR": "100.92.0.1:3000"},
    ("core", "public"): ADMIN | {"LINK_MODE": "public", "CORE_LISTEN_IP": "0.0.0.0",
                                 "EDGE_PEER_IP": "192.0.2.2", "CORE_API_ALLOWED_IP": "192.0.2.2", "CORE_API_HOST": "gateway.example.test"},
    ("edge", "public"): STOREFRONT | {"LINK_MODE": "public", "CORE_API_HOST": "gateway.example.test",
                                      "CORE_API_ADDR": "gateway.example.test:8443"},
}


def settings(path, entries):
    path.write_text("".join(f"{key}={value}\n" for key, value in entries.items()))


def openssl(*args):
    subprocess.run(["openssl", *map(str, args)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def tls_fixtures(directory):
    ca = directory / "fixture-ca"
    ca.mkdir(0o700)
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
            "-subj", "/CN=VPNShop V2 synthetic CA", "-days", "2", "-keyout", ca / "key", "-out", ca / "cert")

    def leaf(cert, key, name, usage):
        openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                "-subj", "/CN=" + name, "-keyout", directory / key, "-out", ca / "request")
        extension = ca / "ext"
        extension.write_text(f"subjectAltName=DNS:{name}\nextendedKeyUsage={usage}\n")
        openssl("x509", "-req", "-in", ca / "request", "-CA", ca / "cert", "-CAkey", ca / "key",
                "-CAcreateserial", "-days", "1", "-extfile", extension, "-out", directory / cert)

    leaf("public_cert", "public_key", "shop.example.test", "serverAuth")
    leaf("admin_cert", "admin_tls_key", "admin.example.test", "serverAuth")
    leaf("core_gw_cert", "core_gw_key", "gateway.example.test", "serverAuth")
    leaf("edge_client_cert", "edge_client_key", "edge.example.test", "clientAuth")
    for name, source in (("monitor_admin_cert", directory / "admin_cert"), ("monitor_public_cert", directory / "public_cert"),
                         ("core_gw_ca", ca / "cert"), ("core_gw_client_ca", ca / "cert")):
        shutil.copyfile(source, directory / name)
    for path in directory.iterdir():
        if path.is_file():
            path.chmod(0o400)
    return ca


def synthetic_material(directory):
    tls_fixtures(directory)
    for name in ("superuser", "migrator", "public", "admin", "worker", "billing", "notifications", "backup", "monitor"):
        password = secrets.token_hex(24) + "+:/@%"
        (directory / ("db_" + name)).write_text(password + "\n")
        if name != "superuser":
            host = "migrate" if name == "migrator" else name
            url = f"postgresql://mzt_{name}:{quote(password, safe='')}@pg-{host}:5432/vpnshop"
            (directory / (name + "_url")).write_text(url + "\n")
    for name in ("web_jwt", "web_cookie", "mail_key", "admin_key", "logical_key",
                 "remnawave_staging_token", "remnawave_staging_api_key"):
        (directory / name).write_text(base64.b64encode(secrets.token_bytes(32)).decode() + "\n")
    (directory / "smtp_url").write_text("smtps://mail.example.test:465\n")
    (directory / "pgbackrest_conf").write_text("[global]\nrepo1-type=s3\nrepo1-storage-verify-tls=y\n"
        "repo1-cipher-type=aes-256-cbc\n" + "".join(f"{k}={secrets.token_hex(24)}\n"
        for k in ("repo1-s3-key", "repo1-s3-key-secret", "repo1-cipher-pass")) + "[vpnshop]\n")
    (directory / "logical_s3_credentials").write_text("[default]\n" + "".join(
        f"{k}={secrets.token_hex(24)}\n" for k in ("aws_access_key_id", "aws_secret_access_key")))
    for path in directory.iterdir():
        if path.is_file():
            path.chmod(0o400)


class Deployment(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.secrets = self.root / "secrets"
        self.secrets.mkdir(0o700)
        synthetic_material(self.secrets)
        self.release = self.root / "release.env"
        self.extra_edge_file = False
        settings(self.release, {key: f"ghcr.io/example/{key.removesuffix('_IMAGE').lower()}@sha256:" + "a" * 64
                                for key in preflight.IMAGES})

    def invoke(self, role, entries):
        path = self.root / "operator.env"
        settings(path, entries)
        directory = self.secrets
        if role == "edge":
            directory = self.root / "edge-secrets"
            if directory.exists():
                shutil.rmtree(directory)
            directory.mkdir(0o700)
            names = {"public_cert", "public_key"}
            if entries.get("LINK_MODE") == "public":
                names |= {"edge_client_cert", "edge_client_key", "core_gw_ca"}
            if self.extra_edge_file:
                names.add("db_worker")
            for name in names:
                if (self.secrets / name).exists():
                    shutil.copy2(self.secrets / name, directory / name)
        return subprocess.run(
            ["python3", SCRIPT, "--role", role, "--env-file", path, "--release-env", self.release,
             "--secrets-dir", directory, "--disposable", "--render"], text=True, capture_output=True, check=False)

    def render(self, role, entries):
        result = self.invoke(role, entries)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn((self.secrets / "web_jwt").read_text().strip(), result.stdout)
        return json.loads(result.stdout)

    def rejects(self, role, entries, error):
        result = self.invoke(role, entries)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(error, result.stderr)
        self.assertNotIn((self.secrets / "web_jwt").read_text().strip(), result.stderr)

    def test_transport_matrix(self):
        for (role, link), entries in CONFIG.items():
            with self.subTest(role=role, link=link):
                conf = self.render(role, entries)
                services = conf["services"]
                self.assertEqual(conf["name"], f"vpnshop-{role}")
                self.assertEqual("db" in services, role != "edge")
                self.assertEqual("admin-api" in services, role != "edge")
                self.assertEqual("public-edge" in services, role != "core")
                if role == "edge":
                    expected = {"public_cert", "public_key"}
                    if link == "public":
                        expected |= {"edge_client_cert", "edge_client_key", "core_gw_ca"}
                    self.assertEqual(set(conf["secrets"]), expected)
                    self.assertEqual(set(services), {"web", "public-edge"})
                if role == "core":
                    listener = "core-gateway" if link == "public" else "public-api"
                    rule = services[listener]["ports"][0]
                    self.assertEqual(str(rule["published"]), "8443" if link == "public" else "3000")
                    if link == "public":
                        self.assertNotIn("ports", services["public-api"])
                if role != "edge":
                    self.assertNotIn("ports", services["db"])
                    self.assertNotIn("ports", services["admin-api"])
                    self.assertNotIn("smtp_url", conf["secrets"])
                    self.assertEqual(services["notifications"]["profiles"], ["mail"])

    def test_micro_profile_renders_limits_before_start(self):
        selection, profile = preflight.resources((1, 1945), "auto")
        self.assertEqual(profile, "micro")
        self.assertEqual(selection["VPNSHOP_DB_MEMORY"], "512m")
        settings(self.root / "resources.env", {"RESOURCE_PROFILE": "micro"})
        result = self.render("single", CONFIG["single", "private"] | {"MZT_ENABLE_LOCAL_BACKUP": "1"})
        preflight.validate_resources(result, (1, 1945))
        postgres = result["services"]["db"]
        self.assertEqual(float(postgres["cpus"]), 1)
        self.assertEqual(int(postgres["mem_limit"]), 512 * 1024 * 1024)
        self.assertIn("shared_buffers=64MB", postgres["command"])
        self.assertIn("work_mem=2MB", postgres["command"])
        with self.assertRaisesRegex(preflight.Invalid, "too small"):
            preflight.resources((1, 1945), "large")
        with self.assertRaisesRegex(preflight.Invalid, "CPU limit on db"):
            postgres["cpus"] = 1.5
            preflight.validate_resources(result, (1, 1945))

    def test_postgresql_isolation_with_and_without_offsite_archiving(self):
        offsite = {"MZT_ENABLE_OFFSITE": "1", "LOGICAL_S3_ENDPOINT": "https://s3.example.test",
                   "LOGICAL_S3_BUCKET": "vpnshop-fixture", "LOGICAL_S3_REGION": "fixture", "LOGICAL_KEY_VERSION": "v1"}
        for (role, link), entries in CONFIG.items():
            for archive in ({}, offsite) if role != "edge" else ({},):
                with self.subTest(role=role, link=link, offsite=bool(archive)):
                    conf = self.render(role, entries | archive)
                    services = conf["services"]
                    for service in services.values():
                        self.assertNotEqual(service.get("network_mode"), "host")
                        for port in service.get("ports", ()):
                            self.assertNotIn(5432, (port["target"], int(port["published"])))
                    if role == "edge":
                        self.assertNotIn("db", services)
                        self.assertFalse(any(name.startswith("db_") for name in conf["secrets"]))
                        continue
                    db = services["db"]
                    self.assertNotIn("network_mode", db)
                    self.assertFalse(db.get("ports"))
                    for network in db["networks"]:
                        if network == "archive-egress" and archive:
                            continue
                        self.assertTrue(conf["networks"][network]["internal"], network)
                    for ingress in ("public-edge", "admin-edge", "core-gateway"):
                        self.assertTrue(set(db["networks"]).isdisjoint(services.get(ingress, {}).get("networks", {})))

    def test_single_is_compatible_with_existing_service_hardening(self):
        conf = self.render("single", CONFIG["single", "private"])
        env = preflight.os.environ | dict(CONFIG["single", "private"]) | preflight.read_settings(self.release) | {
            "SECRETS_DIR": str(self.secrets),
        }
        output = subprocess.check_output(["docker", "compose", "--env-file", "/dev/null", "-f", ROOT / "ops/compose.yml",
                                          "-p", "vpnshop-single", "--profile", "*", "config", "--format", "json"],
                                         text=True, env=env)
        legacy = json.loads(output)
        self.assertEqual(legacy["volumes"]["pgdata"], conf["volumes"]["pgdata"])
        self.assertEqual(legacy["networks"], conf["networks"])
        self.assertEqual(set(legacy["services"]) | {"admin-local"}, set(conf["services"]))
        local = conf["services"]["admin-local"]
        self.assertEqual(local["profiles"], ["admin-cli"])
        self.assertEqual(set(local["networks"]), {"admin-db"})
        self.assertEqual(local["entrypoint"], ["node", "dist/admin-local.js"])
        self.assertNotIn("ports", local)
        for service in legacy["services"]:
            current = conf["services"][service]
            for key in ("cap_drop", "security_opt", "read_only", "init", "user", "ports", "networks"):
                old = legacy["services"][service].get(key)
                self.assertTrue(current.get(key) == old or (key == "user" and service.endswith("-edge") and
                                old is None and current["user"] == "101:101"), f"{service}:{key}")

    def test_private_ipv6_and_observed_peer(self):
        core = self.render("core", ADMIN | {"CORE_LISTEN_IP": "fd00:42::1", "EDGE_PEER_IP": "fd00:42::2",
                                           "CORE_PROXY_PEER_IP": "172.30.80.1"})
        self.assertEqual(core["services"]["public-api"]["environment"]["WEB_TRUSTED_PROXIES"], "172.30.80.1")
        self.render("edge", STOREFRONT | {"CORE_API_ADDR": "[fd00:42::1]:3000"})

    def test_admin_modes_are_independent_of_link(self):
        for link in ("private", "public"):
            for mode, bind, acl in (("local", "127.0.0.1", "127.0.0.1/32"),
                                    ("public", "192.0.2.4", "192.0.2.10/32"),
                                    ("public", "192.0.2.4", "internet"),
                                    ("private", "fd00:55::1", "fd00:55::/64")):
                with self.subTest(mode=mode, link=link, acl=acl):
                    conf = self.render("core", CONFIG["core", link] | {
                        "ADMIN_ACCESS_MODE": mode, "ADMIN_BIND_IP": bind, "ADMIN_CLIENT_CIDRS": acl})
                    self.assertEqual(conf["services"]["admin-api"]["environment"]["ADMIN_ALLOWED_CIDRS"], acl)

    def test_admin_factor_policy_matrix(self):
        for mode, bind, acl in (("local", "127.0.0.1", "127.0.0.1/32"),
                                ("public", "192.0.2.4", "internet"),
                                ("private", "10.90.0.4", "10.90.0.0/24")):
            for policy in ("required", "optional", "disabled"):
                with self.subTest(mode=mode, policy=policy):
                    result = self.invoke("core", CONFIG["core", "private"] | {
                        "ADMIN_ACCESS_MODE": mode, "ADMIN_BIND_IP": bind, "ADMIN_CLIENT_CIDRS": acl,
                        "ADMIN_2FA_POLICY": policy,
                    })
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)["services"]["admin-api"]["environment"]["ADMIN_2FA_POLICY"], policy)
                    self.assertEqual("WARNING" in result.stderr, mode == "public" and policy == "disabled")
        self.rejects("edge", CONFIG["edge", "private"] | {"ADMIN_2FA_POLICY": "disabled"}, "unsupported or derived variables")
        self.rejects("core", CONFIG["core", "private"] | {"ADMIN_2FA_POLICY": "off"}, "Invalid ADMIN_2FA_POLICY")

    def test_tls_uses_system_ca_when_private_ca_is_absent(self):
        (self.secrets / "core_gw_ca").unlink()
        data = self.render("edge", CONFIG["edge", "public"])
        self.assertNotIn("core_gw_ca", data["secrets"])

    def test_overlays_and_conditional_mounts(self):
        base = CONFIG["single", "private"]
        variants = [
            ({"MZT_ENABLE_LOCAL_BACKUP": "1"}, {"logical-local"}, {"backup_url", "logical_key"}),
            ({"MZT_ENABLE_OFFSITE": "1", "LOGICAL_S3_ENDPOINT": "https://s3.example.test",
              "LOGICAL_S3_BUCKET": "vpnshop-fixture", "LOGICAL_S3_REGION": "fixture", "LOGICAL_KEY_VERSION": "v1"},
             {"logical"}, {"backup_url", "logical_key", "logical_s3_credentials", "pgbackrest_conf"}),
            ({"MZT_ENABLE_SMTP_EGRESS": "1", "MAIL_FROM": "VPNShop <sender@example.test>"}, set(), {"smtp_url"}),
            ({"MZT_ENABLE_OAUTH_EGRESS": "1", "GOOGLE_CLIENT_ID": "fixture-client"}, set(), {"google_client_secret"}),
            ({"MZT_ENABLE_OAUTH_EGRESS": "1", "TELEGRAM_CLIENT_ID": "fixture-client", "TELEGRAM_OIDC_VERIFIED": "true"},
             set(), {"telegram_client_secret"}),
            ({"MZT_DEPLOY_ENV": "staging", "MZT_ENABLE_PANEL_EGRESS": "1", "REMNAWAVE_REVISION_MODE": "staging",
              "REMNAWAVE_STAGING_ORIGIN": "https://panel.example.test", "REMNAWAVE_STAGING_LINK_ORIGIN": "https://links.example.test",
              "REMNAWAVE_STAGING_INSTANCE": "staging-fixture", "REMNAWAVE_STAGING_SQUADS": "11111111-1111-4111-8111-111111111111"},
             set(), {"remnawave_staging_token", "remnawave_staging_api_key"}),
        ]
        all_vars, all_services, all_secrets, generated = {}, set(), set(), {}
        for changes, new_services, new_secrets in variants:
            with self.subTest(flags=list(changes)):
                for name in new_secrets:
                    path = self.secrets / name
                    if not path.exists():
                        generated[name] = secrets.token_hex(24) + "\n"
                        path.write_text(generated[name])
                        path.chmod(0o400)
                conf = self.render("single", base | changes)
                self.assertTrue(new_services <= conf["services"].keys() and new_secrets <= conf["secrets"].keys())
                all_vars.update(changes)
                all_services.update(new_services)
                all_secrets.update(new_secrets)
                for name in new_secrets & generated.keys():
                    (self.secrets / name).unlink()
        for name, value in generated.items():
            path = self.secrets / name
            path.unlink(missing_ok=True)
            path.write_text(value)
            path.chmod(0o400)
        conf = self.render("single", base | all_vars)
        self.assertTrue(all_services <= conf["services"].keys() and all_secrets <= conf["secrets"].keys())

    def test_addr_and_role_errors(self):
        for role, link, overrides, error in (
            ("single", "private", {"PUBLIC_HOST": ""}, "DNS hostname"),
            ("single", "private", {"ADMIN_ORIGIN": "http://admin.example.test"}, "HTTPS origin"),
            ("single", "private", {"ADMIN_BIND_IP": "0.0.0.0"}, "ADMIN_ACCESS_MODE"),
            ("single", "private", {"ADMIN_CLIENT_CIDRS": ""}, "CIDR"),
            ("single", "private", {"ADMIN_CLIENT_CIDRS": "internet"}, "CIDR"),
            ("single", "private", {"ADMIN_ACCESS_MODE": "public", "ADMIN_BIND_IP": "0.0.0.0",
                                     "ADMIN_CLIENT_CIDRS": "10.90.0.0/24"}, "Conflicting listener"),
            ("core", "private", {"CORE_LISTEN_IP": "0.0.0.0"}, "distinct private"),
            ("core", "private", {"CORE_LISTEN_IP": "127.0.0.1"}, "distinct private"),
            ("core", "public", {"CORE_API_ALLOWED_IP": ""}, "exact IP"),
            ("edge", "private", {"CORE_API_ADDR": "192.0.2.1:3000"}, "must be private"),
            ("edge", "private", {"CORE_API_ADDR": "127.0.0.1:3000"}, "non-loopback"),
            ("edge", "public", {"CORE_API_ADDR": "https://gateway.example.test:8443"}, "host:port"),
            ("edge", "public", {"CORE_API_HOST": ""}, "DNS hostname"),
            ("edge", "private", {"MZT_ENABLE_SMTP_EGRESS": "1"}, "unsupported"),
            ("edge", "private", {"WEB_TRUSTED_PROXIES": "0.0.0.0/0"}, "derived variables"),
        ):
            with self.subTest(role=role, overrides=overrides):
                self.rejects(role, CONFIG[role, link] | overrides, error)

    def test_provider_switches_and_mail_availability(self):
        base = CONFIG["single", "private"]
        self.rejects("single", base | {"GOOGLE_AUTH_ENABLED": "true"}, "requires a client ID")
        self.rejects("single", base | {"TELEGRAM_AUTH_ENABLED": "true", "TELEGRAM_CLIENT_ID": "fixture",
                     "MZT_ENABLE_OAUTH_EGRESS": "1"}, "verified OIDC")
        conf = self.render("single", base | {"GOOGLE_AUTH_ENABLED": "false", "GOOGLE_CLIENT_ID": "fixture"})
        self.assertNotIn("GOOGLE_CLIENT_ID", conf["services"]["public-api"]["environment"])
        self.assertNotIn("oauth-egress", conf["networks"])
        self.assertNotIn("MAIL_TRANSPORT_ENABLED", conf["services"]["public-api"]["environment"])
        self.assertNotIn("MAIL_TRANSPORT_ENABLED", conf["services"]["admin-api"]["environment"])

    def test_product_config_has_one_authority_and_validates_dependencies(self):
        base = CONFIG["single", "private"]
        brand = 'Бренд "Север"'
        cfg = self.render("single", base | {"BRAND_NAME": brand, "MAINTENANCE_MODE": "true",
                                           "LEGAL_TERMS_URL": "https://example.test/terms?v=1&locale=ru"})
        for app in ("public-api", "admin-api"):
            values = cfg["services"][app]["environment"]
            self.assertEqual(values["BRAND_NAME"], brand)
            self.assertEqual(values["MAINTENANCE_MODE"], "true")
            self.assertEqual(values["PAYMENTS_ENABLED"], "false")
            self.assertEqual(values["REMNAWAVE_ENABLED"], "false")
        self.assertNotIn("BRAND_NAME", cfg["services"]["web"].get("environment", {}))
        self.rejects("edge", CONFIG["edge", "private"] | {"BRAND_NAME": brand}, "unsupported")
        self.rejects("single", base | {"LEGAL_TERMS_URL": "javascript:alert(1)"}, "expected an HTTPS link")
        self.rejects("single", base | {"PAYMENTS_ENABLED": "true"}, "verified Platega contract")
        self.rejects("single", base | {"REMNAWAVE_ENABLED": "true"}, "requires staging panel egress")
        paused = self.render("single", base | {"REMNAWAVE_ENABLED": "false", "MZT_ENABLE_PANEL_EGRESS": "1",
                                              "REMNAWAVE_REVISION_MODE": "staging", "REMNAWAVE_STAGING_ORIGIN": "https://example.test"})
        self.assertNotIn("panel-egress", paused["networks"])
        self.assertNotIn("remnawave_staging_token", paused["secrets"])

    def test_rejects_missing_conditional_secrets_and_wrong_permissions(self):
        self.rejects("single", CONFIG["single", "private"] | {"MZT_ENABLE_OAUTH_EGRESS": "1", "GOOGLE_CLIENT_ID": "fixture"},
                     "google_client_secret")
        (self.secrets / "edge_client_key").unlink()
        self.rejects("edge", CONFIG["edge", "public"], "edge_client_key")
        (self.secrets / "web_cookie").chmod(0o444)
        self.rejects("single", CONFIG["single", "private"], "requires a regular file with mode 0400")

    def test_rejects_shared_keys_and_wrong_tls_key(self):
        cookie = self.secrets / "web_cookie"
        cookie.unlink()
        shutil.copyfile(self.secrets / "web_jwt", cookie)
        cookie.chmod(0o400)
        self.rejects("single", CONFIG["single", "private"], "JWT and cookie secrets must differ")
        wrong = self.secrets / "public_key"
        wrong.unlink()
        shutil.copyfile(self.secrets / "core_gw_key", wrong)
        wrong.chmod(0o400)
        self.rejects("edge", CONFIG["edge", "private"], "Certificate and key differ")

    def test_rejects_production_panel_and_plain_text_secrets(self):
        self.rejects("single", CONFIG["single", "private"] | {"MZT_ENABLE_PANEL_EGRESS": "1", "REMNAWAVE_REVISION_MODE": "staging"},
                     "isolated staging")
        self.rejects("single", CONFIG["single", "private"] | {"JWT_SECRET": "sensitive-canary"}, "derived variables")

    def test_edge_rejects_secrets_present_outside_its_role(self):
        self.extra_edge_file = True
        self.rejects("edge", CONFIG["edge", "private"], "outside its role")


if __name__ == "__main__":
    unittest.main()
