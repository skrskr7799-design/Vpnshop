#!/bin/sh
set -eu
umask 077
case "${S3_ENDPOINT:?}" in https://*) ;; *) exit 64 ;; esac
case "${S3_BUCKET:?}${KEY_VERSION:?}" in *[!a-zA-Z0-9._-]*) exit 64;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export AWS_SHARED_CREDENTIALS_FILE=/run/secrets/logical_s3_credentials AWS_EC2_METADATA_DISABLED=true
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
key="$KEY_VERSION/$stamp"
mzt-with-postgres /run/secrets/backup_url pg_dump --no-password --enable-row-security --no-owner --no-acl -Fc -f "$work/dump"
pg_restore --list "$work/dump" >/dev/null
gpg --batch --pinentry-mode loopback --passphrase-file /run/secrets/logical_key --symmetric --cipher-algo AES256 \
  --output "$work/dump.gpg" "$work/dump"
rm "$work/dump"
digest=$(sha256sum "$work/dump.gpg" | cut -d' ' -f1)
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$work/dump.gpg" "s3://$S3_BUCKET/$key.dump.gpg"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "s3://$S3_BUCKET/$key.dump.gpg" "$work/proof.gpg"
printf '%s  %s\n' "$digest" "$work/proof.gpg" | sha256sum -c - >/dev/null
gpg --batch --pinentry-mode loopback --passphrase-file /run/secrets/logical_key --output "$work/verified.dump" --decrypt "$work/proof.gpg"
pg_restore --list "$work/verified.dump" >/dev/null
printf '{"sha256":"%s","object":"%s.dump.gpg","keyVersion":"%s"}\n' "$digest" "$key" "$KEY_VERSION" > "$work/manifest.json"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$work/manifest.json" "s3://$S3_BUCKET/$key.json"
date -u +%s >/state/proofs/.logical_epoch
mv /state/proofs/.logical_epoch /state/proofs/logical_epoch
