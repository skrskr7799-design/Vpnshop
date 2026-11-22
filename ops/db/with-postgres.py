#!/usr/bin/env python3
"""Pass credentials from a mounted PostgreSQL URL to a libpq tool."""
import os
from pathlib import Path
import sys
from urllib.parse import parse_qs, unquote, urlsplit


def connection(path):
    url = urlsplit(Path(path).read_text(encoding="utf-8").strip())
    database = unquote(url.path.removeprefix("/"))
    if url.scheme not in ("postgres", "postgresql") or not all(
        (url.hostname, url.username, url.password, database)
    ) or url.fragment:
        raise ValueError("Invalid mounted DB URL")
    sslmode = parse_qs(url.query).get("sslmode", ["prefer"])[0]
    if sslmode not in ("prefer", "require", "verify-ca", "verify-full"):
        raise ValueError("Invalid DB TLS mode")
    return {
        "PGHOST": url.hostname, "PGPORT": str(url.port or 5432),
        "PGUSER": unquote(url.username), "PGPASSWORD": unquote(url.password),
        "PGDATABASE": database, "PGSSLMODE": sslmode,
        "PGCONNECT_TIMEOUT": "8",
    }


try:
    settings = connection(sys.argv[1])
except (OSError, ValueError, UnicodeError):
    sys.exit("Invalid mounted database secret")
os.execvpe(sys.argv[2], sys.argv[2:], os.environ | settings)
