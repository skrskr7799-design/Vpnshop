#!/bin/sh
set -eu
case "${EDGE_HOST:-}" in ''|*[!a-zA-Z0-9.-]*) exit 64;; esac
case "${EDGE_APP:-}" in public-api:3000|admin-api:3001) ;; *) exit 64;; esac
case "${EDGE_STATIC:-}" in web:8080|admin:8080) ;; *) exit 64;; esac
: > /tmp/mzt-acl.conf
if [ "$EDGE_APP" = "admin-api:3001" ]; then
    [ -n "${EDGE_ADMIN_CIDRS:-}" ]
    oldifs=$IFS; IFS=,
    set -f
    for network in $EDGE_ADMIN_CIDRS; do
        case "$network" in ''|*[!0-9a-fA-F.:/]*|*/0) exit 64;; esac
        printf 'allow %s;\n' "$network"
    done > /tmp/mzt-acl.conf
    IFS=$oldifs
    printf 'deny all;\n' >> /tmp/mzt-acl.conf
fi
envsubst '${EDGE_HOST} ${EDGE_APP} ${EDGE_STATIC}' < /etc/nginx/edge.conf > /tmp/mzt-edge.conf
sed 's@/etc/nginx/conf.d/\*.conf@/tmp/mzt-edge.conf@' /etc/nginx/nginx.conf > /tmp/mzt-nginx.conf
nginx -t -c /tmp/mzt-nginx.conf
exec nginx -c /tmp/mzt-nginx.conf -g 'daemon off;'
