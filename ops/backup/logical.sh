#!/bin/sh
set -eu
umask 077
work=$(mktemp -d)
target=
trap 'rm -rf "$work"; if [ -n "$target" ]; then rm -rf "$target"; fi' EXIT
export AWS_SHARED_CREDENTIALS_FILE=/run/secrets/logical_s3_credentials AWS_EC2_METADATA_DISABLED=true
export GNUPGHOME="$work/gnupg" AWS_CONFIG_FILE="$work/aws.conf"
printf '[default]\ns3 =\n    addressing_style = path\n' > "$AWS_CONFIG_FILE"
mkdir -m 700 "$GNUPGHOME"
operation=${1:-}
case "$operation" in
  verify|decrypt)
    [ "${MZT_LOGICAL_LOCAL:-0}" = 1 ]
    gpg --batch --pinentry-mode loopback --passphrase-file /run/secrets/logical_key --output "$work/verified.dump" --decrypt
    pg_restore --list "$work/verified.dump" >/dev/null
    if [ "$operation" = decrypt ]; then cat "$work/verified.dump"; fi
    exit 0
    ;;
  export) [ "${MZT_LOGICAL_LOCAL:-0}" = 1 ] ;;
  "") ;;
  *) exit 64 ;;
esac
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mzt-with-postgres /run/secrets/backup_url pg_dump --no-password --enable-row-security --no-owner --no-acl -Fc -f "$work/dump"
pg_restore --list "$work/dump" >/dev/null
gpg --batch --pinentry-mode loopback --passphrase-file /run/secrets/logical_key --symmetric --cipher-algo AES256 \
  --output "$work/dump.gpg" "$work/dump"
rm "$work/dump"
digest=$(sha256sum "$work/dump.gpg" | cut -d' ' -f1)
if [ "${MZT_LOGICAL_LOCAL:-0}" = 1 ]; then
  target=$(mktemp -d /state/proofs/.backup-XXXXXXXX)
  cp "$work/dump.gpg" "$target/dump.gpg"
  (cd "$target"; printf '%s  dump.gpg\n' "$digest" > SHA256SUMS; sha256sum -c SHA256SUMS >/dev/null)
  gpg --batch --pinentry-mode loopback --passphrase-file /run/secrets/logical_key --output "$work/verified.dump" --decrypt "$target/dump.gpg"
  pg_restore --list "$work/verified.dump" >/dev/null
  if [ "$operation" = export ]; then
    cat "$target/dump.gpg"
    exit 0
  fi
  mv -T "$target" "/state/proofs/$stamp-${target##*-}"
  target=
  exit 0
fi
case "${S3_ENDPOINT:?}" in https://*) ;; *) exit 64 ;; esac
case "${S3_BUCKET:?}${KEY_VERSION:?}" in *[!a-zA-Z0-9._-]*) exit 64;; esac
key="$KEY_VERSION/$stamp"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$work/dump.gpg" "s3://$S3_BUCKET/$key.dump.gpg"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "s3://$S3_BUCKET/$key.dump.gpg" "$work/proof.gpg"
printf '%s  %s\n' "$digest" "$work/proof.gpg" | sha256sum -c - >/dev/null
gpg --batch --pinentry-mode loopback --passphrase-file /run/secrets/logical_key --output "$work/verified.dump" --decrypt "$work/proof.gpg"
pg_restore --list "$work/verified.dump" >/dev/null
printf '{"sha256":"%s","object":"%s.dump.gpg","keyVersion":"%s"}\n' "$digest" "$key" "$KEY_VERSION" > "$work/manifest.json"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$work/manifest.json" "s3://$S3_BUCKET/$key.json"
date -u +%s >/state/proofs/.logical_epoch
mv /state/proofs/.logical_epoch /state/proofs/logical_epoch
