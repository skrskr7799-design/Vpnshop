# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node-runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM node-runtime AS build
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     npm install --global --no-audit --no-fund pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     PRISMA_SKIP_POSTINSTALL_GENERATE=true CI=true pnpm install --frozen-lockfile
COPY . .
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     pnpm db:generate && pnpm build
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     pnpm --filter @vpn/api deploy --prod --legacy /runtime && \
    mkdir -p /runtime/node_modules/.prisma && \
    engine="$(find node_modules/.pnpm -path '*/node_modules/.prisma/client' -type d -print -quit)" && \
    test -n "$engine" && cp -a "$engine" /runtime/node_modules/.prisma/client && \
    rm -rf /runtime/src /runtime/prisma /runtime/*.ts /runtime/dist/*.map

FROM node-runtime AS application
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
ENV NODE_ENV=production
COPY --from=build --chown=1000:1000 /runtime /app
USER 1000:1000
CMD ["node","dist/server.js"]

FROM build AS migrator
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
COPY --chmod=0555 ops/db/migrate.sh /usr/local/bin/mzt-migrate
USER 1000:1000
ENTRYPOINT ["mzt-migrate"]

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236 AS nginx-runtime
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
COPY ops/nginx/base.conf /etc/nginx/nginx.conf
USER 101:101
ENTRYPOINT ["nginx","-g","daemon off;"]

FROM nginx-runtime AS web
COPY ops/nginx/static.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist/ /usr/share/nginx/html/

FROM nginx-runtime AS admin
COPY ops/nginx/static.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist/ /usr/share/nginx/html/

FROM nginx-runtime AS edge
COPY ops/nginx/edge.conf /etc/nginx/edge.conf
COPY --chmod=0555 ops/nginx/start.sh /usr/local/bin/mzt-edge
ENTRYPOINT ["mzt-edge"]
