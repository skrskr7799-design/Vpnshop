#!/usr/bin/env python3
"""Validate rendered Compose topology without resolving secret values."""
import ipaddress
import json
import re
import sys
from urllib.parse import urlparse

private = [ipaddress.ip_network(value) for value in
           ("127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7")]


def restricted(network):
    selected = ipaddress.ip_network(network, strict=False)
    return any(selected.version == allowed.version and selected.subnet_of(allowed) for allowed in private)


def fail(reason):
    raise SystemExit(reason)


conf = json.load(sys.stdin)
services = conf["services"]
for name, service in services.items():
    if not ("@sha256:" in service.get("image", "") or
            ("--disposable" in sys.argv and service.get("image", "").startswith("mzt-ci-"))):
        fail(f"{name} lacks an immutable image")
    if service.get("privileged") or service.get("network_mode") == "host" or service.get("cap_add"):
        fail(f"{name} crosses the container boundary")
    if any("docker.sock" in volume.get("source", "") for volume in service.get("volumes", [])):
        fail(f"{name} mounts the Docker socket")
    if service.get("ports") and name not in {"public-edge", "admin-edge"}:
        fail(f"{name} publishes an internal port")
    if "ALL" not in service.get("cap_drop", []) or not service.get("read_only"):
        fail(f"{name} lacks runtime hardening")

edge = services["admin-edge"]
for port in edge["ports"]:
    if not restricted(port.get("host_ip", "0.0.0.0")):
        fail("Admin must bind to an explicit management interface")
networks = edge["environment"].get("EDGE_ADMIN_CIDRS", "").split(",")
if not all(restricted(value.strip()) for value in networks if value.strip()) or not any(value.strip() for value in networks):
    fail("Admin CIDRs must be explicit private or loopback networks")
for api, key in [("public-api", "WEB_ORIGIN"), ("admin-api", "ADMIN_ORIGIN")]:
    origin = urlparse(services[api]["environment"][key])
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        fail(f"{api} requires an exact HTTPS origin")
    edge_name = api.removesuffix("-api") + "-edge"
    host = services[edge_name]["environment"]["EDGE_HOST"]
    if origin.hostname != host or not re.fullmatch(r"[a-z0-9.-]+", host):
        fail(f"{api} certificate host does not match its origin")
if services["public-edge"]["environment"]["EDGE_HOST"] == edge["environment"]["EDGE_HOST"]:
    fail("Public and admin origins must use different hosts")
