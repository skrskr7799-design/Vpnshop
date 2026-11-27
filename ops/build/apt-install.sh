#!/bin/sh
set -eu

ca=/etc/ssl/certs/ca-certificates.crt
if [ ! -s "$ca" ]; then
    # The slim Node image needs TLS before it can install Debian's CA bundle.
    ca=$(mktemp)
    trap 'rm -f "$ca"' EXIT
    node -p 'require("node:tls").rootCertificates.join("\n")' > "$ca"
    chmod 0644 "$ca"
fi

apt() {
    apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/debian.sources \
        -o Dir::Etc::sourceparts=- -o "Acquire::https::CaInfo=$ca" "$@"
}

apt -o APT::Update::Error-Mode=any update
DEBIAN_FRONTEND=noninteractive apt install -y --no-install-recommends "$@"
rm -rf /var/lib/apt/lists/*
