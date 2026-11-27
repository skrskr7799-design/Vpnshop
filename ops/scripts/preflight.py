#!/usr/bin/env python3
"""Render, validate and (optionally) run the selected Docker Compose stack."""
import argparse
import base64
import binascii
import configparser
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import unicodedata
from urllib.parse import unquote, urlsplit
from uuid import UUID

OPS = Path(__file__).resolve().parents[1]
PRIVATE = tuple(map(ipaddress.ip_network, (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7",
)))
IMAGES = {"APPLICATION_IMAGE", "MIGRATOR_IMAGE", "DATABASE_IMAGE", "WEB_IMAGE", "ADMIN_IMAGE", "EDGE_IMAGE", "BACKUP_IMAGE"}
PUBLIC = {"PUBLIC_HOST", "PUBLIC_BIND_IP", "PUBLIC_TLS_PORT"}
LINK = {"LINK_MODE", "CORE_API_HOST"}
CORE = {"CORE_LISTEN_IP", "CORE_API_PORT", "EDGE_PEER_IP", "CORE_API_ALLOWED_IP", "CORE_PROXY_PEER_IP"}
PANEL = {"REMNAWAVE_STAGING_ORIGIN", "REMNAWAVE_STAGING_LINK_ORIGIN", "REMNAWAVE_STAGING_INSTANCE", "REMNAWAVE_STAGING_SQUADS"}
OFFSITE = {"LOGICAL_S3_ENDPOINT", "LOGICAL_S3_BUCKET", "LOGICAL_S3_REGION", "LOGICAL_KEY_VERSION"}
FLAGS = {"MZT_ENABLE_LOCAL_BACKUP", "MZT_ENABLE_OFFSITE", "MZT_ENABLE_SMTP_EGRESS", "MZT_ENABLE_OAUTH_EGRESS", "MZT_ENABLE_PANEL_EGRESS"}
PRODUCT_LINKS = {"SUPPORT_URL", "LEGAL_TERMS_URL", "LEGAL_PRIVACY_URL", "LEGAL_REFUND_URL"}
PRODUCT_FLAGS = {"REGISTRATION_ENABLED", "SUPPORT_ENABLED", "MAINTENANCE_MODE", "PAYMENTS_ENABLED", "REMNAWAVE_ENABLED"}
PRODUCT = PRODUCT_FLAGS | PRODUCT_LINKS | {"BRAND_NAME", "SUPPORT_EMAIL", "LOG_LEVEL"}
APPS = {"PUBLIC_ORIGIN", "ADMIN_HOSTNAME", "ADMIN_ORIGIN", "ADMIN_BIND_IP", "ADMIN_CLIENT_CIDRS", "ADMIN_TLS_PORT",
        "ADMIN_ACCESS_MODE", "ADMIN_2FA_POLICY", "ADMIN_SESSION_HOURS", "ADMIN_IDLE_MINUTES", "CHECKOUT_TTL_MINUTES", "MAIL_FROM",
        "GOOGLE_AUTH_ENABLED", "TELEGRAM_AUTH_ENABLED", "GOOGLE_CLIENT_ID", "TELEGRAM_CLIENT_ID", "TELEGRAM_OIDC_VERIFIED", "REMNAWAVE_REVISION_MODE",
        "BACKUP_MONITOR", "PANEL_MONITOR", "ALERTMANAGER_CONFIG"} | PANEL | OFFSITE | FLAGS | PRODUCT
DEFAULT = {"MZT_DEPLOY_ENV": "production", "ADMIN_ACCESS_MODE": "private", "ADMIN_2FA_POLICY": "required", "LINK_MODE": "private",
           "PUBLIC_TLS_PORT": "443", "ADMIN_TLS_PORT": "443", "PUBLIC_BIND_IP": "127.0.0.1",
           "ADMIN_SESSION_HOURS": "12", "ADMIN_IDLE_MINUTES": "30", "CHECKOUT_TTL_MINUTES": "30",
           "BACKUP_MONITOR": "false", "PANEL_MONITOR": "false"}
for flag in FLAGS:
    DEFAULT[flag] = "0"
NAME = r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
APP_SERVICES = {"db", "migrator", "public-api", "admin-api", "admin-local", "worker", "billing", "notifications",
                "admin", "admin-edge", "exporter", "prometheus", "alertmanager", "alert-sink"}


class Invalid(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def read_settings(path):
    result = {}
    for no, raw in enumerate(path.read_text().splitlines(), 1):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        key, eq, value = raw.partition("=")
        value = value.strip()
        require(eq and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in result,
                f"Invalid or duplicate setting on line {no}")
        if value[:1] in {"'", '"'}:
            require(len(value) >= 2 and value[-1] == value[0], f"Invalid quoting on line {no}")
            value = value[1:-1]
        require(not any(ord(ch) < 32 for ch in value) and "$" not in value, f"Invalid value on line {no}")
        result[key] = value
    return result


def address(value, field):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        raise Invalid(f"{field} requires an exact IP address") from None
    require("%" not in value and not ip.is_multicast and not ip.is_link_local and
            not getattr(ip, "ipv4_mapped", None), f"{field} has an unsupported IP address")
    return ip


def cidr(value):
    try:
        require("/" in value and "%" not in value, "Use an explicit administrative CIDR")
        network = ipaddress.ip_network(value)
    except ValueError:
        raise Invalid("Invalid administrative CIDR") from None
    require(network.prefixlen > 0 and not network.network_address.is_multicast and
            not getattr(network.network_address, "ipv4_mapped", None), "Invalid administrative CIDR")
    return network


def private(network, loopback=False):
    item = network.network_address if hasattr(network, "network_address") else network
    return (loopback or not item.is_loopback) and any(
        item.version == allowed.version and
        (network.subnet_of(allowed) if hasattr(network, "subnet_of") else item in allowed)
        for allowed in PRIVATE
    )


def port(value, field):
    require(re.fullmatch(r"[0-9]{1,5}", value) and 1 <= int(value) <= 65535, f"Invalid {field}")
    return int(value)


def host(value, field):
    require(len(value) <= 253 and re.fullmatch(NAME, value), f"{field} requires a lowercase DNS hostname")
    return value


def origin(value, field):
    try:
        url = urlsplit(value)
        authority = host(url.hostname or "", field) + (f":{url.port}" if url.port and url.port != 443 else "")
        require(value == "https://" + authority, f"{field} requires an exact HTTPS origin")
    except ValueError:
        raise Invalid(f"Invalid {field}") from None
    return url


def endpoint(value, link):
    try:
        url = urlsplit("//" + value)
        require(url.netloc == value and not (url.username or url.password) and url.port,
                "CORE_API_ADDR requires host:port")
        target = url.hostname or ""
        if link == "private":
            ip = address(target, "CORE_API_ADDR")
            require(private(ip), "CORE_API_ADDR must be private and non-loopback")
        else:
            try:
                ip = ipaddress.ip_address(target)
            except ValueError:
                host(target, "CORE_API_ADDR")
            else:
                ip = address(target, "CORE_API_ADDR")
                require(not (ip.is_unspecified or ip.is_loopback), "CORE_API_ADDR must identify the remote Core")
        return value
    except ValueError:
        raise Invalid("Invalid CORE_API_ADDR") from None


def enabled(v, flag, yes="1", no="0"):
    value = v.get(flag) or no
    require(value in {yes, no}, f"Invalid {flag}")
    return value == yes


def design(role, raw, secrets):
    allowed = {"MZT_DEPLOY_ENV"} | (PUBLIC if role != "core" else set()) | (APPS if role != "edge" else set())
    if role != "single":
        allowed |= LINK | (CORE if role == "core" else {"CORE_API_ADDR"})
    require(not (raw.keys() - allowed), "Operator configuration contains unsupported or derived variables")
    v = DEFAULT | {k: value for k, value in raw.items() if value}
    require(v["MZT_DEPLOY_ENV"] in {"production", "staging"}, "Invalid MZT_DEPLOY_ENV")
    link = v["LINK_MODE"]
    require(link in {"private", "public"}, "Invalid LINK_MODE")
    flags = {"public-link"} if role != "single" and link == "public" else set()
    files = ["edge", "mode.edge"] if role == "edge" else ["core", "admin"]
    if role != "core":
        host(v.get("PUBLIC_HOST", ""), "PUBLIC_HOST")
        address(v["PUBLIC_BIND_IP"], "PUBLIC_BIND_IP")
        port(v["PUBLIC_TLS_PORT"], "PUBLIC_TLS_PORT")
    if role != "edge":
        public = origin(v.get("PUBLIC_ORIGIN", ""), "PUBLIC_ORIGIN")
        admin = origin(v.get("ADMIN_ORIGIN", ""), "ADMIN_ORIGIN")
        if role == "single":
            require(public.hostname == v["PUBLIC_HOST"], "Public host and origin differ")
        require(admin.hostname == v.get("ADMIN_HOSTNAME") and public.hostname != admin.hostname, "Admin origin must use its own hostname")
        v["V2_PUBLIC_AUTHORITY"] = public.netloc
        port(v["ADMIN_TLS_PORT"], "ADMIN_TLS_PORT")
        bind = address(v.get("ADMIN_BIND_IP", ""), "ADMIN_BIND_IP")
        mode = v["ADMIN_ACCESS_MODE"]
        require(v["ADMIN_2FA_POLICY"] in {"required", "optional", "disabled"}, "Invalid ADMIN_2FA_POLICY")
        if mode == "public" and v["ADMIN_2FA_POLICY"] == "disabled":
            print("WARNING: public administrative access with 2FA disabled", file=sys.stderr)
        require(mode in {"private", "public", "local"}, "Invalid ADMIN_ACCESS_MODE")
        require((mode == "local" and bind.is_loopback) or (mode == "private" and private(bind)) or
                (mode == "public" and not bind.is_loopback), "Admin listener conflicts with ADMIN_ACCESS_MODE")
        clients = [c.strip() for c in v.get("ADMIN_CLIENT_CIDRS", "").split(",")]
        if clients != ["internet"] or mode != "public":
            networks = [cidr(c) for c in clients]
            if mode != "public":
                require(all(private(n, loopback=True) for n in networks), "Private/local admin requires restricted private CIDRs")
        v["ADMIN_CLIENT_CIDRS"] = ",".join(clients)
        require(1 <= port(v["CHECKOUT_TTL_MINUTES"], "CHECKOUT_TTL_MINUTES") <= 1440, "Invalid checkout duration")
        for field in ("ADMIN_IDLE_MINUTES", "ADMIN_SESSION_HOURS"):
            try:
                number = float(v[field])
            except ValueError:
                raise Invalid(f"Invalid {field}") from None
            require(math.isfinite(number) and number > 0, f"Invalid {field}")
        if v.get("ALERTMANAGER_CONFIG"):
            path = Path(v["ALERTMANAGER_CONFIG"])
            require(path.is_absolute() and path.is_file(), "ALERTMANAGER_CONFIG requires an existing absolute file")
        if role == "single":
            files += ["edge", "mode.single"]
    if role != "single":
        if link == "public":
            host(v.get("CORE_API_HOST", ""), "CORE_API_HOST")
        else:
            require(not v.get("CORE_API_HOST"), "CORE_API_HOST applies to public link only")
        if role == "core":
            listen = address(v.get("CORE_LISTEN_IP", ""), "CORE_LISTEN_IP")
            peer = address(v.get("EDGE_PEER_IP", ""), "EDGE_PEER_IP")
            require(not peer.is_unspecified and not peer.is_loopback, "EDGE_PEER_IP must identify a remote host")
            v.setdefault("CORE_API_PORT", "3000" if link == "private" else "8443")
            port(v["CORE_API_PORT"], "CORE_API_PORT")
            if link == "private":
                require(private(listen) and private(peer) and listen != peer, "Private Core requires distinct private listener and peer addresses")
                require(not v.get("CORE_API_ALLOWED_IP"), "CORE_API_ALLOWED_IP applies to public link only")
                proxy = address(v.get("CORE_PROXY_PEER_IP", str(peer)), "CORE_PROXY_PEER_IP")
                require(private(proxy), "The observed private proxy peer must be private")
                v["V2_WEB_PROXY"] = str(proxy)
            else:
                allow = address(v.get("CORE_API_ALLOWED_IP", ""), "CORE_API_ALLOWED_IP")
                require(not allow.is_unspecified and not allow.is_loopback and not listen.is_loopback,
                        "Public Core requires an explicit remote Edge allowlist and a non-loopback listener")
                require(not v.get("CORE_PROXY_PEER_IP"), "CORE_PROXY_PEER_IP applies to private link only")
                v["V2_WEB_PROXY"] = "172.30.72.2"
            files += ["mode.core", "link." + link]
        else:
            endpoint(v.get("CORE_API_ADDR", ""), link)
            files += ["link.edge." + link]
            if link == "public" and os.path.lexists(secrets / "core_gw_ca"):
                files += ["link.edge.ca"]
                flags.add("public-link+file")
    if role == "edge":
        return v, files, flags
    for flag in PRODUCT_FLAGS:
        enabled(v, flag, "true", "false")
    require(not enabled(v, "PAYMENTS_ENABLED", "true", "false"), "Payments require a verified Platega contract and admitted adapter")
    brand = v.get("BRAND_NAME", "MZT")
    require(bool(brand.strip()) and len(brand) <= 80 and not any(
        unicodedata.category(ch) in {"Cc", "Cf"} for ch in brand), "Invalid BRAND_NAME")
    email = v.get("SUPPORT_EMAIL")
    require(not email or len(email) <= 254 and re.fullmatch(r"[A-Za-z0-9_+.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", email)
            and ".." not in email and not email.startswith("."), "Invalid SUPPORT_EMAIL")
    for key in PRODUCT_LINKS:
        value = v.get(key)
        if not value:
            continue
        try:
            url = urlsplit(value)
            require(url.scheme == "https" and bool(url.hostname) and not url.netloc.count("@")
                    and not any(ch.isspace() or ch == chr(92) or unicodedata.category(ch) in {"Cc", "Cf"} for ch in value)
                    and len(value) <= 2048, f"Invalid {key}: expected an HTTPS link without credentials")
            _ = url.port
        except ValueError:
            raise Invalid(f"Invalid {key}: expected an HTTPS link without credentials") from None
    require(v.get("LOG_LEVEL", "info") in {"fatal", "error", "warn", "info", "debug", "trace", "silent"}, "Invalid LOG_LEVEL")
    if enabled(v, "MZT_ENABLE_SMTP_EGRESS"):
        require(bool(v.get("MAIL_FROM")), "SMTP requires MAIL_FROM")
        files += ["mail"]
        flags.add("smtp")
    else:
        require(not v.get("MAIL_FROM"), "MAIL_FROM requires SMTP egress")
    configured = [p for p in ("google", "telegram") if v.get(p.upper() + "_CLIENT_ID")]
    verified = enabled(v, "TELEGRAM_OIDC_VERIFIED", "true", "false")
    providers = []
    for provider in ("google", "telegram"):
        switch = provider.upper() + "_AUTH_ENABLED"
        active = (enabled(v, switch, "true", "false") if switch in v else provider in configured)
        if active:
            require(provider in configured, f"{provider} authentication requires a client ID and secret")
            providers.append(provider)
    require("telegram" not in providers or verified, "Telegram requires verified OIDC and a client ID together")
    oauth = enabled(v, "MZT_ENABLE_OAUTH_EGRESS")
    require(oauth == bool(providers), "OAuth egress requires configured provider client IDs and secrets")
    if oauth:
        files += ["oauth"] + ["oauth." + p for p in providers]
        flags.update(providers)
    for p in ("google", "telegram"):
        require(p in configured or not os.path.lexists(secrets / (p + "_client_secret")),
                f"{p} client ID and secret must be configured together")
    for provider in ("google", "telegram"):
        v[f"V2_{provider.upper()}_CONFIGURED"] = str(provider in providers).lower()
    egress = enabled(v, "MZT_ENABLE_PANEL_EGRESS")
    explicit_panel = v.get("REMNAWAVE_ENABLED")
    require(explicit_panel != "true" or egress, "REMNAWAVE_ENABLED requires staging panel egress")
    panel = egress and explicit_panel != "false"
    v["REMNAWAVE_ENABLED"] = str(panel).lower()
    if explicit_panel == "false":
        v["REMNAWAVE_REVISION_MODE"] = "off"
        v["PANEL_MONITOR"] = "false"
    require(v.get("REMNAWAVE_REVISION_MODE", "off") == ("staging" if panel else "off"), "Panel egress requires explicit staging revision mode")
    if panel:
        require(v["MZT_DEPLOY_ENV"] == "staging", "Panel egress supports isolated staging only")
        for key in ("REMNAWAVE_STAGING_ORIGIN", "REMNAWAVE_STAGING_LINK_ORIGIN"):
            origin(v.get(key, ""), key)
        require(re.fullmatch(r"staging-[a-z0-9-]{1,50}", v.get("REMNAWAVE_STAGING_INSTANCE", "")), "Invalid staging panel instance")
        try:
            for value in v.get("REMNAWAVE_STAGING_SQUADS", "").split(","):
                UUID(value.strip())
        except ValueError:
            raise Invalid("Panel staging requires valid squad UUIDs") from None
        files += ["egress"]
        flags.add("panel")
        if os.path.lexists(secrets / "remnawave_staging_api_key"):
            files += ["egress.panel-key"]
            flags.add("panel+file")
    elif explicit_panel != "false":
        require(not any(v.get(k) for k in PANEL), "Staging panel settings require panel egress")
    offsite = enabled(v, "MZT_ENABLE_OFFSITE")
    if offsite:
        origin(v.get("LOGICAL_S3_ENDPOINT", ""), "LOGICAL_S3_ENDPOINT")
        require(all(re.fullmatch(r"[a-zA-Z0-9._-]+", v.get(k, "")) for k in OFFSITE - {"LOGICAL_S3_ENDPOINT"}),
                "Invalid off-site bucket, region or key version")
        files += ["backup"]
        flags.update({"backup", "offsite"})
    else:
        require(not any(v.get(k) for k in OFFSITE), "Off-site settings require off-site backup")
    if enabled(v, "MZT_ENABLE_LOCAL_BACKUP"):
        files += ["backup.local"]
        flags.add("backup")
    require(not enabled(v, "BACKUP_MONITOR", "true", "false") or offsite, "Backup monitoring requires off-site backup")
    require(not enabled(v, "PANEL_MONITOR", "true", "false") or panel, "Panel monitoring requires staging panel egress")
    return v, files, flags


# CPU and MiB floors are admission thresholds, not workload capacity promises.
RESOURCE_PROFILES = {
    "micro": (1, 1536, 1, 512, 64, 2),
    "small": (2, 3072, 1, 1024, 128, 4),
    "standard": (2, 4096, 1.5, 2048, 128, 4),
    "large": (4, 8192, 2, 3072, 256, 8),
}


def docker_capacity(env):
    result = subprocess.run(["docker", "info", "--format", "{{json .}}"], env=env,
                            capture_output=True, check=False, text=True, timeout=30)
    require(result.returncode == 0, "Cannot read Docker host capacity. Check the Docker daemon and permissions")
    info = json.loads(result.stdout)
    cpu, memory = int(info["NCPU"]), int(info["MemTotal"]) // (1024 * 1024)
    require(cpu > 0 and memory > 0, "Docker did not report usable host capacity")
    return cpu, memory


def resources(capacity, requested, role="single"):
    require(requested in {"auto", *RESOURCE_PROFILES}, "RESOURCE_PROFILE must be auto, micro, small, standard or large")
    # The Edge has no PostgreSQL and is admitted by its rendered service caps.
    if role == "edge":
        return {}, "edge"
    cpu, memory = capacity
    candidates = [name for name, limits in RESOURCE_PROFILES.items() if cpu >= limits[0] and memory >= limits[1]]
    require(bool(candidates), "Docker host capacity is below the smallest candidate profile (1 CPU, 1536 MiB)")
    profile = candidates[-1] if requested == "auto" else requested
    require(profile in candidates, f"Docker host capacity is too small for the {profile} profile")
    _, _, db_cpu, db_memory, buffers, work_mem = RESOURCE_PROFILES[profile]
    return {"VPNSHOP_DB_CPUS": str(db_cpu), "VPNSHOP_DB_MEMORY": f"{db_memory}m",
            "VPNSHOP_DB_SHARED_BUFFERS": f"{buffers}MB", "VPNSHOP_DB_WORK_MEM": f"{work_mem}MB"}, profile


def validate_resources(conf, capacity):
    cpu, memory = capacity
    for name, service in conf["services"].items():
        limit = float(service.get("cpus", 0))
        ram = int(service.get("mem_limit", 0))
        require(0.01 <= limit <= cpu, f"Invalid or excessive CPU limit on {name} for the Docker host")
        require(0 < ram <= memory * 1024 * 1024, f"Invalid or excessive memory limit on {name} for the Docker host")


def compose(settings, role, files, secrets, release, project, disposable, *, project_dir=None, monitoring_dir=None, resources_path=None):
    require(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project), "Invalid Compose project")
    if project != f"vpnshop-{role}":
        require(disposable and project.startswith("mzt-ci-"), "Use the fixed Compose project for this role")
    common = {"APPLICATION_IMAGE", "MIGRATOR_IMAGE", "DATABASE_IMAGE", "ADMIN_IMAGE"}
    keys = common.copy() if role != "edge" else set()
    keys.add("EDGE_IMAGE")
    if role != "core":
        keys.add("WEB_IMAGE")
    if "backup" in files or "backup.local" in files:
        keys.add("BACKUP_IMAGE")
    for key in keys:
        value = release.get(key, "")
        require(immutable(value, disposable), "Missing or mutable release image: " + key)
    # Compose extends interpolates the complete legacy file before selecting a service.
    # Role-inapplicable placeholders never become part of a rendered service.
    v = {key: "unused.invalid/unused" for key in IMAGES} | {
        "PUBLIC_HOST": "unused.invalid", "PUBLIC_ORIGIN": "https://unused.invalid",
        "ADMIN_HOSTNAME": "unused.invalid", "ADMIN_ORIGIN": "https://unused.invalid",
        "ADMIN_BIND_IP": "127.0.0.1", "ADMIN_CLIENT_CIDRS": "127.0.0.1/32",
    } | settings | {key: release[key] for key in keys} | {"SECRETS_DIR": str(secrets)}
    env = {key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")}
    # Drop irrelevant interpolation variables, including empty/default overrides from the caller.
    for key in PUBLIC | LINK | CORE | APPS | IMAGES | {"V2_WEB_PROXY", "V2_PUBLIC_AUTHORITY", "CORE_API_ADDR", "MZT_DEPLOY_ENV", "V2_GOOGLE_CONFIGURED", "V2_TELEGRAM_CONFIGURED"}:
        env.pop(key, None)
    env.update(v)
    env["V2_LEGACY_COMPOSE"] = str(OPS / "compose.yml")
    env["V2_MONITORING_DIR"] = str(monitoring_dir or OPS / "monitoring")
    path = resources_path or (project_dir / "config" / "resources.env" if project_dir else None)
    resource_settings = {}
    if path and (path.exists() or path.is_symlink()):
        require(path.is_file() and not path.is_symlink(), "resources.env must be a regular file")
        resource_settings = read_settings(path)
    require(not (resource_settings.keys() - {"RESOURCE_PROFILE"}), "Unexpected key in resources.env")
    capacity = (2, 4096) if disposable else docker_capacity(env)
    derived, profile = resources(capacity, resource_settings.get("RESOURCE_PROFILE", "auto"), role)
    for key in ("VPNSHOP_DB_CPUS", "VPNSHOP_DB_MEMORY", "VPNSHOP_DB_SHARED_BUFFERS", "VPNSHOP_DB_WORK_MEM"):
        env.pop(key, None)
    env.update(derived)
    env["VPNSHOP_RESOURCE_PROFILE"] = profile
    command = ["docker", "compose", "--project-directory", str(project_dir or OPS), "--env-file", "/dev/null", "-p", project, "--profile", "monitoring"]
    for name in files:
        command += ["-f", str(OPS / "compose" / (name + ".yml"))]
    result = subprocess.run(command + ["--profile", "*", "config", "--format", "json"],
                            env=env, capture_output=True, text=True, check=False)
    require(result.returncode == 0, "Docker Compose could not render the selected modules")
    conf = json.loads(result.stdout)
    validate_resources(conf, capacity)
    return command, env, conf


def immutable(image, disposable):
    return bool(re.fullmatch(r"[a-z0-9][a-zA-Z0-9./_:-]*@sha256:[a-f0-9]{64}", image) or
                (disposable and re.fullmatch(r"mzt-ci-[a-z0-9-]+:[a-z0-9-]+", image)))


def hardened(conf, disposable):
    for name, service in conf["services"].items():
        require(immutable(service.get("image", ""), disposable), f"{name} lacks an immutable image")
        require(not any(service.get(k) for k in ("privileged", "cap_add", "network_mode", "pid", "ipc", "devices")),
                f"{name} crosses the container boundary")
        require(not any("docker.sock" in v.get("source", "") or "docker.sock" in v.get("target", "")
                        for v in service.get("volumes", [])), f"{name} mounts the Docker socket")
        require("ALL" in service.get("cap_drop", []) and service.get("read_only") and service.get("init") and
                any(opt in {"no-new-privileges:true", "no-new-privileges=true", "no-new-privileges"}
                    for opt in service.get("security_opt", [])), f"{name} lacks runtime hardening")


def expected_networks(role, v, flags, files):
    services = {"web": {"public-assets"}, "public-edge": {"public-ingress", "public-assets"}} if role != "core" else {}
    if role != "edge":
        services |= {
            "db": {"public-db", "admin-db", "tasks-db", "finance-db", "notifications-db", "monitoring-db", "backup-db", "migration-db"},
            "migrator": {"migration-db"}, "public-api": {"public-api-edge", "public-db", "public-metrics"},
            "admin-api": {"admin-api-edge", "admin-db", "admin-metrics"}, "admin-local": {"admin-db"}, "worker": {"tasks-db"},
            "billing": {"finance-db"}, "notifications": {"notifications-db"},
            "admin": {"admin-assets"}, "admin-edge": {"admin-ingress", "admin-assets", "admin-api-edge"},
            "exporter": {"monitoring-db", "monitoring"}, "prometheus": {"monitoring", "public-metrics", "admin-metrics"},
            "alertmanager": {"monitoring", "alerting"}, "alert-sink": {"alerting"},
        }
        if "smtp" in flags:
            services["notifications"].add("smtp-egress")
        if flags & {"google", "telegram"}:
            services["public-api"].add("oauth-egress")
        if "panel" in flags:
            for name in ("public-api", "admin-api", "worker"):
                services[name].add("panel-egress")
        if "offsite" in flags:
            services["db"].add("archive-egress")
            services["logical"] = {"backup-db", "archive-egress"}
        if "backup.local" in files:
            services["logical-local"] = {"backup-db"}
    if role == "single":
        services["public-edge"].add("public-api-edge")
    elif role == "core":
        if v["LINK_MODE"] == "private":
            services["public-api"].add("core-link")
        else:
            services["core-gateway"] = {"public-api-edge", "gateway-ingress"}
    return services


def validate_topology(conf, role, v, flags, files):
    services = conf["services"]
    expected = expected_networks(role, v, flags, files)
    require(set(services) == set(expected), "Rendered service set differs from the selected role and overlays")
    networks = conf["networks"]
    expected_segments = set.union(*expected.values())
    require(set(networks) == expected_segments, "Unexpected or missing rendered networks")
    external = {"public-ingress", "admin-ingress", "gateway-ingress", "core-link", "smtp-egress",
                "panel-egress", "oauth-egress", "archive-egress"}
    for name in expected_segments:
        network = networks[name]
        require(bool(network.get("internal")) == (name not in external) and not network.get("external") and
                network.get("driver", "bridge") == "bridge", f"Invalid isolation for {name}")
    if "core-link" in networks:
        opts = networks["core-link"].get("driver_opts", {})
        require(opts.get("com.docker.network.bridge.enable_ip_masquerade") == "false", "Private Core segment enables masquerading")
    publishes = {}
    if role != "core":
        publishes["public-edge"] = (v["PUBLIC_BIND_IP"], int(v["PUBLIC_TLS_PORT"]), 8443)
    if role != "edge":
        publishes["admin-edge"] = (v["ADMIN_BIND_IP"], int(v["ADMIN_TLS_PORT"]), 8443)
    if role == "core":
        if v["LINK_MODE"] == "public":
            publishes["core-gateway"] = (v["CORE_LISTEN_IP"], int(v["CORE_API_PORT"]), 8443)
        else:
            publishes["public-api"] = (v["CORE_LISTEN_IP"], int(v["CORE_API_PORT"]), 3000)
    seen = []
    for name, service in services.items():
        require(set(service.get("networks", {})) == expected[name], f"Unexpected networks on {name}")
        rules = service.get("ports", [])
        require(len(rules) == int(name in publishes), f"Unexpected port publication on {name}")
        for rule in rules:
            ip = address(rule.get("host_ip", ""), f"{name} listener")
            number = int(rule["published"])
            require((str(ip), number, rule["target"]) == (str(ipaddress.ip_address(publishes[name][0])), *publishes[name][1:]) and
                    rule.get("protocol") == "tcp", f"Invalid port binding for {name}")
            for prior, previous_port in seen:
                require(number != previous_port or not (ip == prior or ip.is_unspecified or prior.is_unspecified), "Conflicting listener addresses and ports")
            seen.append((ip, number))
    if role != "edge":
        web = services["public-api"]["environment"]
        admin = services["admin-api"]["environment"]
        local_admin = services["admin-local"]
        require(local_admin.get("profiles") == ["admin-cli"] and local_admin.get("entrypoint") == ["node", "dist/admin-local.js"]
                and not local_admin.get("command") and local_admin.get("healthcheck") == {"disable": True}
                and not local_admin.get("depends_on") and "ipv4_address" not in local_admin["networks"]["admin-db"]
                and "ipv6_address" not in local_admin["networks"]["admin-db"] and local_admin["image"] == services["admin-api"]["image"],
                "Local administrative commands must use a one-shot isolated application container")
        require(web["WEB_ORIGIN"] == v["PUBLIC_ORIGIN"] and web["WEB_TRUSTED_PROXIES"] == v.get("V2_WEB_PROXY", "172.30.72.2"),
                "Public API origin or trusted proxy is incorrect")
        require(admin["ADMIN_ORIGIN"] == v["ADMIN_ORIGIN"] and admin["ADMIN_ALLOWED_CIDRS"] == v["ADMIN_CLIENT_CIDRS"] and
                admin["ADMIN_TRUSTED_PROXIES"] == "172.30.73.2" and admin["ADMIN_ACCESS_MODE"] == v["ADMIN_ACCESS_MODE"]
                and admin["ADMIN_2FA_POLICY"] == v["ADMIN_2FA_POLICY"],
                "Administrative API access policy is incorrect")
        require(services["admin-edge"]["networks"]["admin-api-edge"]["ipv4_address"] == admin["ADMIN_TRUSTED_PROXIES"] and
                services["admin-edge"]["environment"]["EDGE_APP"] == "admin-api:3001" and
                services["admin-edge"]["environment"]["EDGE_ADMIN_CIDRS"] == v["ADMIN_CLIENT_CIDRS"] and
                services["admin-edge"]["environment"]["EDGE_ADMIN_MODE"] == v["ADMIN_ACCESS_MODE"],
                "Administrative edge access policy is incorrect")
        require(any(m.get("source") == "pgdata" and m.get("target") == "/state/db" for m in services["db"].get("volumes", [])),
                "PostgreSQL must retain the existing pgdata layout")
        require(("mail" not in services["notifications"].get("profiles", [])) == ("smtp" in flags),
                "Notification process activation differs from SMTP policy")
        require((web.get("MAIL_TRANSPORT_ENABLED") == "true") == ("smtp" in flags) and
                (admin.get("MAIL_TRANSPORT_ENABLED") == "true") == ("smtp" in flags),
                "Application mail availability differs from SMTP policy")
        for provider in ("google", "telegram"):
            require((web.get(provider.upper() + "_AUTH_ENABLED") == "true") == (provider in flags),
                    f"Rendered authentication policy differs for {provider}")
    if role != "core":
        edge = services["public-edge"]["environment"]
        require(edge["EDGE_SCOPE"] == "public" and edge["EDGE_HOST"] == v["PUBLIC_HOST"] and edge["EDGE_STATIC"] == "web:8080",
                "Public edge routing is incorrect")
        if role == "single":
            require(edge["EDGE_APP"] == "public-api:3000" and
                    services["public-edge"]["networks"]["public-api-edge"]["ipv4_address"] == "172.30.72.2",
                    "Single internal proxy is incorrect")
        else:
            require(edge["EDGE_APP"] == v["CORE_API_ADDR"] and edge["EDGE_UPSTREAM_SCHEME"] == ("https" if "public-link" in flags else "http"),
                    "Edge upstream transport is incorrect")
            if "public-link" in flags:
                require(edge["EDGE_CORE_HOST"] == v["CORE_API_HOST"] and
                        (edge.get("EDGE_PRIVATE_CA") == "1") == ("public-link+file" in flags),
                        "Edge TLS verification settings are incorrect")
    if "core-gateway" in services:
        gw = services["core-gateway"]
        require(gw["environment"]["EDGE_SCOPE"] == "gateway" and gw["environment"]["EDGE_HOST"] == v["CORE_API_HOST"] and
                gw["environment"]["EDGE_GATEWAY_PEER"] == v["CORE_API_ALLOWED_IP"] and gw["environment"]["EDGE_APP"] == "public-api:3000" and
                gw["networks"]["public-api-edge"]["ipv4_address"] == "172.30.72.2", "Core mTLS gateway is incorrectly wired")


def crypto(*args, content=None):
    result = subprocess.run(["openssl", *map(str, args)], input=content, capture_output=True, check=False)
    require(result.returncode == 0, "Invalid TLS material (certificate, CA or private key)")
    return result.stdout


def schema_inventory():
    for line in (OPS / "templates/secrets.list").read_text().splitlines():
        if line and not line.startswith("#"):
            yield line.split("|")


def host_ownership(image, env):
    result = subprocess.run(["docker", "info", "--format", "{{json .SecurityOptions}}"], env=env,
                            capture_output=True, check=False, text=True)
    require(result.returncode == 0, "Docker daemon is required to validate secret ownership")
    options = json.loads(result.stdout) or []
    if not any("rootless" in option or "userns" in option for option in options):
        return lambda owner: owner
    probe = subprocess.run(["docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only",
                            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "101:101",
                            "--entrypoint", "/bin/sh", image,
                            "-ec", "cat /proc/self/uid_map; echo GID; cat /proc/self/gid_map"],
                           env=env, capture_output=True, check=False, text=True)
    require(probe.returncode == 0, "Pull the reviewed edge image to validate Docker namespace ownership")
    uid, divider, gid = probe.stdout.partition("GID\n")
    require(bool(divider), "Docker namespace mapping is unavailable")
    maps = [[tuple(map(int, line.split())) for line in part.splitlines() if line.strip()] for part in (uid, gid)]

    def translate(owner):
        identifiers = []
        for value, ranges in zip(map(int, owner.split(":")), maps, strict=True):
            matches = [outside + value - inside for inside, outside, length in ranges if inside <= value < inside + length]
            require(len(matches) == 1, "A secret owner is outside the Docker namespace")
            identifiers.append(str(matches[0]))
        return ":".join(identifiers)

    return translate


def secret_format(name, fmt, path, data):
    if fmt in {"certificate", "ca"}:
        crypto("x509", "-in", path, "-checkend", "0", "-noout")
        if fmt == "ca":
            require(b"CA:TRUE" in crypto("x509", "-in", path, "-noout", "-ext", "basicConstraints"), f"{name} is not a CA")
        return None
    if fmt == "key":
        return crypto("pkey", "-in", path, "-passin", "pass:", "-pubout")
    value = data.decode("utf-8").rstrip("\r\n")
    require(bool(value) and "\0" not in value and len(data) <= 16384, f"Invalid format for {name}")
    if fmt != "ini":
        require(not any(ord(c) < 32 for c in value) and value.strip() == value, f"Invalid format for {name}")
    require(not re.search(r"(?i)^(demo|example|test|placeholder|change[-_ ]?me|replace[-_ ]?me|not-a-real)(?:$|[-_])", value),
            f"Demonstration secret in {name}")
    if fmt in {"password", "token32"}:
        require(len(value) >= 32 and len(set(value)) >= 12, f"Weak secret in {name}")
    if fmt == "base64-32":
        try:
            decoded = base64.b64decode(value, validate=True)
        except binascii.Error:
            raise Invalid(f"Invalid base64 format for {name}") from None
        require(len(decoded) == 32 and len(set(decoded)) >= 12, f"Invalid or weak secret in {name}")
    if fmt == "smtp-url":
        try:
            url = urlsplit(value)
            require(url.scheme in {"smtp", "smtps"} and url.hostname and not url.fragment and
                    (url.port is None or url.port > 0), f"Invalid SMTP URL in {name}")
        except ValueError:
            raise Invalid(f"Invalid SMTP URL in {name}") from None
    if fmt == "ini":
        config = configparser.ConfigParser(interpolation=None, default_section="__defaults__")
        try:
            config.read_string(value)
            if name == "pgbackrest_conf":
                section = config["global"]
                require(section.get("repo1-type") == "s3" and section.get("repo1-storage-verify-tls") == "y" and
                        section.get("repo1-cipher-type") == "aes-256-cbc" and "vpnshop" in config,
                        "Off-site pgBackRest requires S3 with TLS verification and AES-256 encryption")
                credentials = [section.get(k, "") for k in ("repo1-s3-key", "repo1-s3-key-secret", "repo1-cipher-pass")]
            else:
                section = config["default"]
                credentials = [section.get(k, "") for k in ("aws_access_key_id", "aws_secret_access_key")]
            require(all(len(entry) >= 16 and not re.search(r"(?i)^(replace|example|placeholder|changeme)", entry)
                        for entry in credentials), f"Missing or demonstration credentials in {name}")
        except (configparser.Error, KeyError):
            raise Invalid(f"Invalid INI format for {name}") from None
    return value


def verify_secrets(conf, role, v, flags, directory, owner_on_host):
    require(directory.is_dir() and not directory.is_symlink() and stat.S_IMODE(directory.stat().st_mode) == 0o700,
            "The secrets directory must be a real directory with mode 0700")
    services = conf["services"]
    files = conf.get("secrets", {})
    mounts = {}
    for service, definition in services.items():
        for mount in definition.get("secrets", []):
            name = mount["source"]
            require(name not in mounts or service not in mounts[name], f"Duplicate mount of {name}")
            mounts.setdefault(name, set()).add(service)
    expected = {}
    data = {}
    ownership = {}
    for name, roles, condition, _, fmt, owner, mode, consumers in schema_inventory():
        applicable = role in roles.split(",") and (condition == "always" or condition in flags)
        if not applicable:
            require(name not in mounts, f"Unexpected secret mounted: {name}")
            continue
        entries = (entry.partition("@") for entry in consumers.split(","))
        services_for_secret = {service for service, _, flag in entries if not flag or flag in flags} & services.keys()
        expected[name] = services_for_secret
        ownership[name] = owner
        path = directory / name
        require(files.get(name, {}).get("file") == str(path) and bool(services_for_secret), f"Unexpected source for {name}")
        try:
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == int(mode, 8), f"{name} requires a regular file with mode {mode}")
            if owner_on_host:
                expected_owner = owner_on_host(owner)
                require(f"{info.st_uid}:{info.st_gid}" == expected_owner, f"Incorrect owner of {name}. Expected {expected_owner}")
            require(info.st_size <= 65536, f"Secret file too large: {name}")
            payload = path.read_bytes()
            data[name] = secret_format(name, fmt, path, payload)
        except (OSError, UnicodeError, ValueError):
            raise Invalid(f"Missing, unreadable or malformed secret: {name}") from None
    require(mounts == expected and set(files) == set(expected), "The rendered secret mounts do not match the role inventory")
    if role == "edge":
        require({path.name for path in directory.iterdir()} == set(expected), "The Edge secrets directory contains material outside its role")
    for name, definition in services.items():
        for mount in definition.get("secrets", []):
            source = mount["source"]
            expected_target = {
                "public_cert": "edge_cert", "admin_cert": "edge_cert", "core_gw_cert": "edge_cert",
                "public_key": "edge_key", "admin_tls_key": "edge_key", "core_gw_key": "edge_key",
                "monitor_public_cert": "public_cert", "monitor_admin_cert": "admin_cert",
            }.get(source, source)
            require(mount["target"].removeprefix("/run/secrets/") == expected_target, f"Unsafe mount target for {source}")
            require(definition.get("user") == ownership[source], f"Runtime user cannot read {source}")
        for key, value in definition.get("environment", {}).items():
            if key.endswith("_FILE") and value:
                require(value in {"/run/secrets/" + m["target"].removeprefix("/run/secrets/")
                                  for m in definition.get("secrets", [])}, f"Unbound file environment variable on {name}")
    if role != "edge":
        require(data["web_jwt"] != data["web_cookie"], "JWT and cookie secrets must differ")
        for role_name in ("migrator", "public", "admin", "worker", "billing", "notifications", "monitor", "backup"):
            key = role_name + "_url"
            if not data.get(key):
                continue
            try:
                url = urlsplit(data[key])
                alias = "migrate" if role_name == "migrator" else role_name
                require(url.scheme in {"postgres", "postgresql"} and url.hostname == "pg-" + alias and
                        url.port == 5432 and unquote(url.username or "") == "mzt_" + role_name and url.path == "/vpnshop" and
                        not url.fragment and unquote(url.password or "") == data["db_" + role_name],
                        f"DB URL in {key} does not match its restricted PostgreSQL role")
            except ValueError:
                raise Invalid(f"Invalid DB URL in {key}") from None
    pairs = [("public_cert", "public_key", v.get("PUBLIC_HOST")), ("admin_cert", "admin_tls_key", v.get("ADMIN_HOSTNAME")),
             ("core_gw_cert", "core_gw_key", v.get("CORE_API_HOST")), ("edge_client_cert", "edge_client_key", None)]
    for cert, key, hostname in pairs:
        if cert in data:
            path = directory / cert
            require(crypto("x509", "-in", path, "-pubkey", "-noout") == data[key], f"Certificate and key differ for {cert}")
            if hostname:
                match = crypto("x509", "-in", path, "-noout", "-checkhost", hostname)
                require(b"does match certificate" in match, f"TLS hostname differs for {cert}")


def legacy(conf, disposable):
    hardened(conf, disposable)
    for name, service in conf["services"].items():
        require(not service.get("ports") or name in {"public-edge", "admin-edge"}, f"{name} publishes an internal port")
    admin = conf["services"]["admin-edge"]
    for rule in admin["ports"]:
        require(private(address(rule.get("host_ip", ""), "Administrative listener"), loopback=True),
                "Admin must bind to an explicit management interface")
    clients = [entry.strip() for entry in admin["environment"].get("EDGE_ADMIN_CIDRS", "").split(",") if entry.strip()]
    require(clients and all(private(cidr(entry), loopback=True) for entry in clients),
            "Admin CIDRs must be explicit private or loopback networks")
    for api, key in (("public-api", "WEB_ORIGIN"), ("admin-api", "ADMIN_ORIGIN")):
        url = origin(conf["services"][api]["environment"][key], api)
        edge = conf["services"][api.removesuffix("-api") + "-edge"]
        require(url.hostname == edge["environment"]["EDGE_HOST"], f"{api} certificate host does not match its origin")
    require(conf["services"]["public-edge"]["environment"]["EDGE_HOST"] != admin["environment"]["EDGE_HOST"],
            "Public and admin origins must use different hosts")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", choices=["single", "core", "edge"])
    parser.add_argument("--env-file", type=Path, default=Path("/opt/vpnshop/config/.env"))
    parser.add_argument("--release-env", type=Path, default=OPS.parent / "release.env")
    parser.add_argument("--secrets-dir", type=Path, default=Path("/opt/vpnshop/secrets"))
    parser.add_argument("--project-name")
    parser.add_argument("--disposable", action="store_true", help="CI fixtures, allows local test tags and skips host UID checks")
    parser.add_argument("--render", action="store_true", help="Print the validated Compose JSON (no secret contents)")
    parser.add_argument("operation", nargs=argparse.REMAINDER, help="Optional Compose operation after --")
    args = parser.parse_args()
    try:
        if not args.role:
            require(not args.operation and not args.render, "Select a role for V2 rendering or execution")
            legacy(json.load(sys.stdin), args.disposable)
            return
        operation = args.operation
        if operation and operation[0] == "--":
            operation = operation[1:]
        # Keep runtime commands on the validated project and files.
        require(not operation or (not args.disposable and operation[0] in {"up", "down", "ps", "run", "exec", "logs", "restart", "stop"}),
                "Unsupported Compose operation or disposable execution")
        require(args.secrets_dir.is_absolute(), "Secrets directory must be absolute")
        v, files, flags = design(args.role, read_settings(args.env_file), args.secrets_dir)
        command, env, conf = compose(v, args.role, files, args.secrets_dir, read_settings(args.release_env),
                                    args.project_name or f"vpnshop-{args.role}", args.disposable,
                                    resources_path=args.env_file.parent / "resources.env")
        hardened(conf, args.disposable)
        validate_topology(conf, args.role, v, flags, files)
        ownership = None if args.disposable else host_ownership(env["EDGE_IMAGE"], env)
        verify_secrets(conf, args.role, v, flags, args.secrets_dir, ownership)
        if args.render:
            print(json.dumps(conf, indent=2))
        else:
            print(f"VPNShop V2 {args.role} preflight passed", flush=True)
        if operation:
            os.execvpe(command[0], command + operation, env)
    except Invalid as problem:
        sys.exit(str(problem))
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, subprocess.TimeoutExpired):
        sys.exit("Invalid or unreadable deployment input")


if __name__ == "__main__":
    main()
