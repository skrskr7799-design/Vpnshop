#!/bin/sh
set -eu
case "${EDGE_HOST:-}" in ''|*[!a-zA-Z0-9.-]*) exit 64;; esac
case "${EDGE_SCOPE:-legacy}" in
    gateway)
        case "${EDGE_PUBLIC_HOST:-}" in ''|*[!a-z0-9.:-]*) exit 64;; esac
        case "${EDGE_GATEWAY_PEER:-}" in ''|*[!0-9a-fA-F.:]*) exit 64;; esac
        envsubst '${EDGE_HOST} ${EDGE_PUBLIC_HOST} ${EDGE_GATEWAY_PEER}' < /etc/nginx/gateway.conf > /tmp/mzt-edge.conf
        ;;
    public|legacy)
        EDGE_UPSTREAM_SCHEME=${EDGE_UPSTREAM_SCHEME:-http}
        EDGE_HOST_HEADER='$http_host'
        export EDGE_UPSTREAM_SCHEME EDGE_HOST_HEADER
        : > /tmp/mzt-upstream.conf
        : > /tmp/mzt-acl.conf
        case "${EDGE_SCOPE:-legacy}:${EDGE_STATIC:-}:${EDGE_UPSTREAM_SCHEME}" in
            public:web:8080:http|public:web:8080:https)
                app=$(printf '%s\n' "${EDGE_APP:-}" | grep -Ex '([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{1,5}') || exit 64
                [ "$app" = "$EDGE_APP" ] || exit 64
                cat /etc/nginx/public-routes.conf > /tmp/mzt-routes.conf
                ;;
            legacy:web:8080:http|legacy:admin:8080:http)
                case "$EDGE_STATIC:$EDGE_APP" in web:8080:public-api:3000|admin:8080:admin-api:3001) ;; *) exit 64;; esac
                cat > /tmp/mzt-routes.conf <<'CONF'
location /webhooks/ {
    client_max_body_size 16k;
    proxy_pass $app$request_uri;
}
location /api/ { proxy_pass $app$request_uri; }
CONF
                ;;
            *) exit 64;;
        esac
        if [ "$EDGE_STATIC" = admin:8080 ]; then
            case "${EDGE_ADMIN_MODE:-private}" in private|public|local) ;; *) exit 64;; esac
            if [ "${EDGE_ADMIN_MODE:-private}:${EDGE_ADMIN_CIDRS:-}" != public:internet ]; then
                case "${EDGE_ADMIN_CIDRS:-}" in ''|,*|*,|*,,*) exit 64;; esac
                oldifs=$IFS; IFS=,
                set -f
                for network in $EDGE_ADMIN_CIDRS; do
                    case "$network" in ''|*[!0-9a-fA-F.:/]*|*/0) exit 64;; esac
                    printf 'allow %s;\n' "$network"
                done > /tmp/mzt-acl.conf
                IFS=$oldifs
                printf 'deny all;\n' >> /tmp/mzt-acl.conf
            fi
        fi
        if [ "$EDGE_UPSTREAM_SCHEME" = https ]; then
            case "${EDGE_CORE_HOST:-}" in ''|*[!a-z0-9.-]*) exit 64;; esac
            EDGE_HOST_HEADER=$EDGE_CORE_HOST
            case "${EDGE_PRIVATE_CA:-0}" in
                0) EDGE_CORE_CA=/etc/ssl/certs/ca-certificates.crt;;
                1) EDGE_CORE_CA=/run/secrets/core_gw_ca;;
                *) exit 64;;
            esac
            export EDGE_CORE_CA
            envsubst '${EDGE_CORE_HOST} ${EDGE_CORE_CA}' > /tmp/mzt-upstream.conf <<'CONF'
proxy_ssl_certificate /run/secrets/edge_client_cert;
proxy_ssl_certificate_key /run/secrets/edge_client_key;
proxy_ssl_trusted_certificate ${EDGE_CORE_CA};
proxy_ssl_server_name on;
proxy_ssl_name ${EDGE_CORE_HOST};
proxy_ssl_verify on;
proxy_ssl_verify_depth 3;
CONF
        fi
        envsubst '${EDGE_HOST} ${EDGE_APP} ${EDGE_STATIC} ${EDGE_UPSTREAM_SCHEME} ${EDGE_HOST_HEADER}' < /etc/nginx/edge.conf > /tmp/mzt-edge.conf
        ;;
    *) exit 64;;
esac
sed 's@/etc/nginx/conf.d/\*.conf@/tmp/mzt-edge.conf@' /etc/nginx/nginx.conf > /tmp/mzt-nginx.conf
nginx -t -c /tmp/mzt-nginx.conf
exec nginx -c /tmp/mzt-nginx.conf -g 'daemon off;'
