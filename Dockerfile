# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS node-runtime
COPY ops/build/trixie.sources /etc/apt/sources.list.d/debian.sources
COPY --chmod=0555 ops/build/apt-install.sh /usr/local/bin/mzt-apt-install
RUN mzt-apt-install openssl ca-certificates
WORKDIR /app

FROM node-runtime AS dependencies
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     npm install --global --no-audit --no-fund pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     PRISMA_SKIP_POSTINSTALL_GENERATE=true CI=true pnpm install --frozen-lockfile
COPY tsconfig*.json ./
FROM dependencies AS shared-source
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src

FROM shared-source AS api-source
COPY apps/api/tsconfig.json apps/api/tsup.config.ts apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/prisma apps/api/prisma

FROM api-source AS application-build
RUN --mount=type=secret,id=proxy_ca if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; pnpm db:generate && pnpm --filter @vpn/api build
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     PRISMA_SKIP_POSTINSTALL_GENERATE=true pnpm --filter @vpn/api deploy --prod --legacy /runtime && \
    engine="$(dirname "$(find node_modules/.pnpm -path '*/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node' -type f -print -quit)")" && \
    test -f "$engine/schema.prisma" && \
    client="$(cd /runtime && node -p 'require.resolve("@prisma/client/package.json")')" && \
    generated="$(dirname "$(dirname "$(dirname "$client")")")/.prisma/client" && \
    rm -rf "$generated" && mkdir -p "$(dirname "$generated")" && cp -a "$engine" "$generated" && \
    rm -rf /runtime/src /runtime/prisma /runtime/*.ts /runtime/dist/*.map

FROM node-runtime AS application
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION} org.opencontainers.image.source=https://github.com/skrskr7799-design/Vpnshop
ENV NODE_ENV=production
COPY --from=application-build --chown=1000:1000 /runtime /app
USER 1000:1000
RUN node -e 'const {PrismaClient}=require("@prisma/client"); new PrismaClient().$disconnect()' && test -f dist/server.js
CMD ["node","dist/server.js"]

FROM dependencies AS migrator
RUN mzt-apt-install postgresql-client python3-minimal
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION} org.opencontainers.image.source=https://github.com/skrskr7799-design/Vpnshop
COPY apps/api/prisma apps/api/prisma
COPY ops/db/grants.sql /app/ops/db/grants.sql
COPY --chmod=0555 ops/db/migrate.sh /usr/local/bin/mzt-migrate
COPY --chmod=0555 ops/db/with-postgres.py /usr/local/bin/mzt-with-postgres
USER 1000:1000
ENTRYPOINT ["mzt-migrate"]

FROM shared-source AS frontend-source
COPY packages/ui/tsconfig.json packages/ui/
COPY packages/ui/src packages/ui/src

FROM frontend-source AS web-build
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public
RUN pnpm --filter @vpn/web build

FROM frontend-source AS admin-build
COPY apps/admin/tsconfig.json apps/admin/vite.config.ts apps/admin/index.html apps/admin/
COPY apps/admin/src apps/admin/src
RUN pnpm --filter @vpn/admin build

FROM nginx:1.30-alpine@sha256:8eb04fe3b385090e9aa02961f77398ad09b6bf33ab07f6669a5bb7acce22c0d3 AS nginx-runtime
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION} org.opencontainers.image.source=https://github.com/skrskr7799-design/Vpnshop
COPY --chmod=0444 ops/nginx/base.conf /etc/nginx/nginx.conf
USER 101:101
ENTRYPOINT ["nginx","-g","daemon off;"]

FROM nginx-runtime AS web
COPY --chmod=0444 ops/nginx/static.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist/ /usr/share/nginx/html/

FROM nginx-runtime AS admin
COPY --chmod=0444 ops/nginx/static.conf /etc/nginx/conf.d/default.conf
COPY --from=admin-build /app/apps/admin/dist/ /usr/share/nginx/html/

FROM nginx-runtime AS edge
COPY --chmod=0444 ops/nginx/edge.conf ops/nginx/gateway.conf ops/nginx/public-routes.conf /etc/nginx/
COPY --chmod=0555 ops/nginx/start.sh /usr/local/bin/mzt-edge
ENTRYPOINT ["mzt-edge"]
