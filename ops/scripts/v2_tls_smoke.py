#!/usr/bin/env python3
"""Exercise the real Nginx configurations on disposable Docker networks and CAs."""
import http.client
import io
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tarfile
import time
import uuid
from tempfile import TemporaryDirectory

from test_v2_compose import tls_fixtures

OPS = Path(__file__).resolve().parents[1]
BASE = next(line.split()[1] for line in (OPS.parent / "Dockerfile").read_text().splitlines()
            if line.startswith("FROM ") and line.endswith(" AS nginx-runtime"))
NODE = "node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0"
STUB = """require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (['/api/auth/me', '/api/me/subscription/access'].includes(req.url)) {
    res.setHeader('cache-control', 'private, no-store');
    return res.end(JSON.stringify({subject: req.headers.cookie}));
  }
  const restriction = {
    '/api/orders/disabled': 'PAYMENTS_DISABLED',
    '/api/auth/register/maintenance': 'MAINTENANCE_MODE',
    '/api/me/support/disabled': 'SUPPORT_DISABLED',
  }[req.url];
  if (restriction) {
    res.statusCode = 503;
    return res.end(JSON.stringify({error: {code: restriction}}));
  }
  res.end(JSON.stringify({url: req.url, host: req.headers.host,
    forwardedHost: req.headers['x-forwarded-host'], proto: req.headers['x-forwarded-proto'],
    client: req.headers['x-forwarded-for'], forwarded: req.headers.forwarded}));
}).listen(process.argv[1], '0.0.0.0');"""


def docker(*args):
    result = subprocess.run(["docker", *map(str, args)], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("Docker smoke command failed: " + result.stderr.strip())
    return result.stdout.strip()


class TLSConnection(http.client.HTTPSConnection):
    def connect(self):
        self.sock = self._context.wrap_socket(socket.create_connection(("127.0.0.1", self.port), 4),
                                              server_hostname=self.host)


def request(context, host, port, path, headers=None, *, method="GET", with_headers=False):
    conn = TLSConnection(host, port, context=context, timeout=5)
    try:
        conn.request(method, path, headers={"Host": host} | (headers or {}))
        reply = conn.getresponse()
        body = reply.read()
        if with_headers:
            return reply.status, body, reply.headers
        return reply.status, body
    finally:
        conn.close()


def wait(context, host, port, route, expected=200, headers=None):
    for _ in range(30):
        try:
            status, content = request(context, host, port, route, headers)
            if status == expected:
                return json.loads(content) if status == 200 else content
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(.25)
    raise RuntimeError("TLS service did not reach the expected route")


def smoke(folder):
    prefix = "mzt-ci-v2-" + uuid.uuid4().hex[:8]
    link, upstream = prefix + "-link", prefix + "-api"
    running, networks = [], []
    hardened = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777"]
    edge_image = os.environ.get("MZT_V2_EDGE_IMAGE")
    built_fixture = not edge_image
    if built_fixture:
        edge_image = prefix + ":fixture"
        dockerfile = folder / "Dockerfile"
        dockerfile.write_text(f"""
FROM {BASE}
COPY --chmod=0444 base.conf /etc/nginx/nginx.conf
COPY --chmod=0444 edge.conf gateway.conf public-routes.conf /etc/nginx/
COPY --chmod=0555 start.sh /usr/local/bin/mzt-edge
USER 101:101
""")
        docker("build", "-f", dockerfile, "-t", edge_image, OPS / "nginx")

    def start(name, network, alias, extra, passwords):
        container = prefix + "-" + name
        running.append(container)
        docker("run", "-d", "--name", container, "--network", network, "--network-alias", alias,
               *hardened, "--user", "101:101", "--tmpfs", "/run/secrets:rw,nosuid,nodev,noexec,mode=0700,uid=101,gid=101",
               "--entrypoint", "/bin/sh", *extra, edge_image, "-ec",
               "for n in $(seq 1 100); do [ ! -e /run/secrets/.ready ] || exec /bin/sh /usr/local/bin/mzt-edge; sleep .1; done; exit 64")
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            for target, source in passwords.items():
                info = tarfile.TarInfo(target)
                data = (folder / source).read_bytes()
                info.size = len(data)
                info.mode = 0o400
                archive.addfile(info, io.BytesIO(data))
        # The application UID creates its own fixtures in a private tmpfs, even with user namespaces.
        process = subprocess.run(["docker", "exec", "-i", container, "/bin/sh", "-euc",
                                  "umask 077; cd /run/secrets; tar xf -; chmod 0400 ./*; touch .ready"],
                                 input=stream.getvalue(), capture_output=True, check=False)
        if process.returncode:
            raise RuntimeError("Cannot prepare isolated TLS fixture permissions: " + process.stderr.decode().strip())
        return container

    def port(container):
        return int(docker("port", container, "8443/tcp").split(":")[-1])

    def peer(container, network):
        return json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", container))[network]["IPAddress"]

    def edge(name, addr, scheme="http", trust="core_gw_ca", tls_name="gateway.example.test"):
        material = {"edge_cert": "public_cert", "edge_key": "public_key"}
        if scheme == "https":
            material |= {"edge_client_cert": "edge_client_cert", "edge_client_key": "edge_client_key", "core_gw_ca": trust}
        return start(name, link, name, [
                     "-p", "127.0.0.1::8443", "-e", "EDGE_SCOPE=public", "-e", "EDGE_HOST=shop.example.test",
                     "-e", "EDGE_STATIC=web:8080", "-e", f"EDGE_APP={addr}", "-e", f"EDGE_UPSTREAM_SCHEME={scheme}",
                     "-e", f"EDGE_CORE_HOST={tls_name}", "-e", "EDGE_PRIVATE_CA=1"], material)

    def gateway(name, client, alias):
        gateway_material = {"edge_cert": "core_gw_cert", "edge_key": "core_gw_key", "core_gw_client_ca": "core_gw_client_ca"}
        container = start(name, link, alias, [
            "-p", "127.0.0.1::8443",
            "-e", "EDGE_SCOPE=gateway", "-e", "EDGE_HOST=gateway.example.test", "-e", "EDGE_PUBLIC_HOST=shop.example.test",
            "-e", f"EDGE_GATEWAY_PEER={peer(client, link)}"], gateway_material)
        docker("network", "connect", upstream, container)
        return container

    try:
        for net in (link, upstream):
            docker("network", "create", net)
            networks.append(net)
        api = prefix + "-stub"
        running.append(api)
        docker("run", "-d", "--name", api, "--network", upstream, "--network-alias", "public-api",
               *hardened, "--user", "1000:1000", "--entrypoint", "node", NODE, "-e", STUB, "3000")
        # A separate deployment has a private WireGuard/NetBird-like listener address.
        docker("network", "connect", link, api)
        ca = tls_fixtures(folder)
        context = ssl.create_default_context(cafile=str(ca / "cert"))
        with_client = ssl.create_default_context(cafile=str(ca / "cert"))
        with_client.load_cert_chain(folder / "edge_client_cert", folder / "edge_client_key")

        private = edge("private", peer(api, link) + ":3000")
        assert wait(context, "shop.example.test", port(private), "/api/ready")["host"] == "shop.example.test"
        public = edge("public", "core-gw:8443", "https")
        gw = gateway("gateway", public, "core-gw")
        output = wait(context, "shop.example.test", port(public), "/api/ready")
        assert output["host"] == output["forwardedHost"] == "shop.example.test" and output["proto"] == "https"
        for proxy in (private, public):
            for path, expected in (("/api/orders/disabled", "PAYMENTS_DISABLED"),
                                   ("/api/auth/register/maintenance", "MAINTENANCE_MODE"),
                                   ("/api/me/support/disabled", "SUPPORT_DISABLED")):
                status, payload = request(context, "shop.example.test", port(proxy), path)
                assert status == 503 and json.loads(payload) == {"error": {"code": expected}}
        for proxy in (private, public):
            for path, method in (("/api/auth/me", "GET"), ("/api/me/subscription/access", "POST")):
                for identity in ("fixture-first", "fixture-second", "fixture-first"):
                    status, payload, response_headers = request(
                        context, "shop.example.test", port(proxy), path, {"Cookie": "session=" + identity},
                        method=method, with_headers=True,
                    )
                    assert status == 200 and json.loads(payload) == {"subject": "session=" + identity}
                    assert response_headers["Cache-Control"] == "private, no-store"
                    assert response_headers.get("Age") is None
        for path in ("/api/auth/oauth/google/callback?code=only-local", "/webhooks/platega/test-only"):
            code, payload = request(context, "shop.example.test", port(public), path,
                                    {"X-Forwarded-For": "203.0.113.39", "X-MZT-Edge-Client-IP": "203.0.113.39",
                                     "Forwarded": "for=203.0.113.39", "X-Forwarded-Host": "untrusted.example.test"})
            assert code == 200 and json.loads(payload)["url"] == path
            assert "203.0.113.39" not in payload.decode() and "untrusted.example.test" not in payload.decode()
        for path in ("/api/staff", "/api/admin", "/api/auth/2fa/enroll/start", "/api/metrics", "/webhooks/unknown"):
            assert request(context, "shop.example.test", port(public), path)[0] == 404
        try:
            no_cert = request(context, "gateway.example.test", port(gw), "/api/ready",
                              {"X-MZT-Edge-Client-IP": "192.0.2.5"})[0]
        except ssl.SSLError:
            no_cert = 400
        assert no_cert >= 400
        assert request(with_client, "gateway.example.test", port(gw), "/api/ready",
                       {"X-MZT-Edge-Client-IP": "192.0.2.5"})[0] == 403
        wrong_ca = folder / "wrong-ca"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                        "-subj", "/CN=Wrong fixture CA", "-days", "1", "-keyout", folder / "wrong-ca-key", "-out", wrong_ca],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        untrusted = edge("wrong-trust", "second-gw:8443", "https", trust="wrong-ca")
        second = gateway("second", untrusted, "second-gw")
        client_header = {"X-MZT-Edge-Client-IP": "192.0.2.5"}
        wait(with_client, "gateway.example.test", port(second), "/api/ready", 403, client_header)
        wait(context, "shop.example.test", port(untrusted), "/api/ready", 503)
        wrong_name = edge("wrong-name", "other-gw:8443", "https", tls_name="wrong.example.test")
        third = gateway("third", wrong_name, "other-gw")
        wait(with_client, "gateway.example.test", port(third), "/api/ready", 403, client_header)
        wait(context, "shop.example.test", port(wrong_name), "/api/ready", 503)
        # An empty administrative ACL fails startup. Public wildcard access requires its explicit mode and sentinel.
        admin_material = {"edge_cert": "admin_cert", "edge_key": "admin_tls_key"}
        admin = start("admin", link, "admin-edge", [
            "-p", "127.0.0.1::8443", "-e", "EDGE_HOST=admin.example.test", "-e", "EDGE_STATIC=admin:8080",
            "-e", "EDGE_APP=admin-api:3001", "-e", "EDGE_ADMIN_MODE=public", "-e", "EDGE_ADMIN_CIDRS=internet",
        ], admin_material)
        wait(context, "admin.example.test", port(admin), "/metrics", 404)
        empty = start("empty-acl", link, "empty-acl", [
            "-e", "EDGE_HOST=admin.example.test", "-e", "EDGE_STATIC=admin:8080",
            "-e", "EDGE_APP=admin-api:3001", "-e", "EDGE_ADMIN_MODE=public",
        ], admin_material)
        assert docker("wait", empty) == "64"
        docker("stop", api)
        for proxy in (private, public):
            payload = wait(context, "shop.example.test", port(proxy), "/api/ready", 503)
            assert json.loads(payload) == {"error": {"code": "SERVICE_UNAVAILABLE"}}
        print("TLS smoke passed: private proxy, mTLS gateway, CA and hostname checks, access modes, public route and forwarding isolation")
    except BaseException:
        for container in running:
            result = subprocess.run(["docker", "logs", "--tail", "6", container], capture_output=True, text=True)
            if result.returncode == 0:
                print(container + ": " + (result.stdout + result.stderr).strip())
        raise
    finally:
        subprocess.run(["docker", "rm", "-f", *running], capture_output=True)
        for net in reversed(networks):
            subprocess.run(["docker", "network", "rm", net], capture_output=True)
        if built_fixture:
            subprocess.run(["docker", "image", "rm", edge_image], capture_output=True)


if __name__ == "__main__":
    with TemporaryDirectory() as temp:
        smoke(Path(temp))
