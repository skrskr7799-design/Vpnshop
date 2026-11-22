FROM postgres:17-bookworm@sha256:837bed18782820fe967067cb5328b02b0d9992c1be9a37ee0c9c492cfc03af3b
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
RUN install -d -o 999 -g 999 /state/db && touch /state/db/.keep && chown 999:999 /state/db/.keep
COPY --chmod=0555 ops/db/bootstrap.sh /docker-entrypoint-initdb.d/10-mzt-roles.sh
USER 999:999
ENV PGDATA=/state/db/pgdata
