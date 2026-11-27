#!/bin/sh
# Run inside the pinned db image as its unprivileged default user. APT verifies
# the live Debian indexes using the image's archive keyring. No packages are installed.
set -eu
export LC_ALL=C
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/lists/partial" "$work/cache/archives/partial" "$work/conf.d"
touch "$work/status"
cat > "$work/debian.sources" <<'SOURCES'
Types: deb
URIs: https://deb.debian.org/debian/
Suites: bookworm bookworm-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://deb.debian.org/debian-security/
Suites: bookworm-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
SOURCES
cat > "$work/apt.conf" <<APT
Dir::Etc::Parts "$work/conf.d";
Dir::Etc::Main "/dev/null";
Dir::Etc::SourceList "$work/debian.sources";
Dir::Etc::SourceParts "-";
Dir::State::Lists "$work/lists";
Dir::State::Status "$work/status";
Dir::Cache "$work/cache";
APT::Update::Error-Mode "any";
Acquire::Languages "none";
Acquire::Retries "2";
Acquire::https::Timeout "30";
APT
export APT_CONFIG="$work/apt.conf"
apt-get update >&2
for package in zlib1g libsqlite3-0 libxml2; do
    candidates=$(apt-cache madison "$package")
    newest=''
    while IFS='|' read -r _ version _source; do
        version=$(printf '%s' "$version" | tr -d '[:space:]')
        if [ -n "$version" ] && { [ -z "$newest" ] || dpkg --compare-versions "$version" gt "$newest"; }; then
            newest="$version"
        fi
    done <<INDEX
$candidates
INDEX
    test -n "$newest"
    printf '%s %s\n' "$package" "$newest"
done
