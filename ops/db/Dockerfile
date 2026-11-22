# syntax=docker/dockerfile:1
FROM postgres:17-bookworm@sha256:837bed18782820fe967067cb5328b02b0d9992c1be9a37ee0c9c492cfc03af3b AS postgres-base
RUN rm -f /etc/apt/sources.list.d/pgdg.list

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS backrest-build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc meson ninja-build pkg-config \
    libssl-dev libxml2-dev libpq-dev liblz4-dev libzstd-dev libbz2-dev libyaml-dev liblzma-dev zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=proxy_ca \
    if [ -r /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    curl -fLsS --retry 2 https://codeload.github.com/pgbackrest/pgbackrest/tar.gz/refs/tags/release/2.57.0 -o /tmp/source.tar.gz && \
    echo "d794519c0ecb4ec17f41c4267d07fe80ab6b3ac9cc1de5c7984887c5e6d7448a  /tmp/source.tar.gz" | sha256sum -c - && \
    mkdir /source && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /source && \
    cd /source && meson setup build --buildtype=release && ninja -C build

FROM postgres-base AS database
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
RUN apt-get update && apt-get install -y --no-install-recommends libxml2 liblz4-1 libzstd1 libbz2-1.0 libyaml-0-2 liblzma5 && \
    rm -rf /var/lib/apt/lists/* && rm -f /usr/local/bin/gosu && \
    install -d -o 999 -g 999 /state/db /state/repo /state/proofs && \
    touch /state/db/.keep /state/repo/.keep /state/proofs/.keep && chown 999:999 /state/db/.keep /state/repo/.keep /state/proofs/.keep
COPY --from=backrest-build /source/build/src/pgbackrest /usr/local/bin/pgbackrest
COPY --chmod=0555 ops/db/bootstrap.sh /docker-entrypoint-initdb.d/10-mzt-roles.sh
USER 999:999
ENV PGDATA=/state/db/pgdata

FROM database AS backup
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
USER 0
RUN apt-get update && apt-get install -y --no-install-recommends awscli gnupg && rm -rf /var/lib/apt/lists/*
COPY --chmod=0555 ops/db/with-postgres.py /usr/local/bin/mzt-with-postgres
COPY --chmod=0555 ops/backup/logical.sh /usr/local/bin/mzt-logical
USER 999:999
ENTRYPOINT ["mzt-logical"]
