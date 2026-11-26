# syntax=docker/dockerfile:1
FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS node-runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM node-runtime AS build
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     npm install --global --no-audit --no-fund pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     PRISMA_SKIP_POSTINSTALL_GENERATE=true CI=true pnpm install --frozen-lockfile
COPY . .
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     pnpm db:generate && pnpm build
RUN --mount=type=secret,id=proxy_ca     if [ -r /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi;     PRISMA_SKIP_POSTINSTALL_GENERATE=true pnpm --filter @vpn/api deploy --prod --legacy /runtime && \
    engine="$(dirname "$(find node_modules/.pnpm -path '*/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node' -type f -print -quit)")" && \
    test -f "$engine/schema.prisma" && \
    client="$(cd /runtime && node -p 'require.resolve("@prisma/client/package.json")')" && \
    generated="$(dirname "$(dirname "$(dirname "$client")")")/.prisma/client" && \
    rm -rf "$generated" && mkdir -p "$(dirname "$generated")" && cp -a "$engine" "$generated" && \
    rm -rf /runtime/src /runtime/prisma /runtime/*.ts /runtime/dist/*.map

FROM node-runtime AS application
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
ENV NODE_ENV=production
COPY --from=build --chown=1000:1000 /runtime /app
USER 1000:1000
RUN node -e 'const {PrismaClient}=require("@prisma/client"); new PrismaClient().$disconnect()' && test -f dist/server.js
CMD ["node","dist/server.js"]

FROM build AS migrator
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client python3-minimal && rm -rf /var/lib/apt/lists/*
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION}
COPY --chmod=0555 ops/db/migrate.sh /usr/local/bin/mzt-migrate
COPY --chmod=0555 ops/db/with-postgres.py /usr/local/bin/mzt-with-postgres
USER 1000:1000
ENTRYPOINT ["mzt-migrate"]

FROM nginx:1.30-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3 AS nginx-runtime
RUN apk upgrade --no-cache libxml2
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
COPY ops/nginx/edge.conf ops/nginx/gateway.conf ops/nginx/public-routes.conf /etc/nginx/
COPY --chmod=0555 ops/nginx/start.sh /usr/local/bin/mzt-edge
ENTRYPOINT ["mzt-edge"]
