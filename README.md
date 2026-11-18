# vpn-shop

Монорепа: `apps/api` (Fastify + Prisma), `apps/web` (публичный сайт), `apps/admin` (админка), `packages/shared` (общие типы и zod-схемы).

## Быстрый старт

```bash
cp .env.example .env        # заполнить значения
pnpm install
pnpm db:up                  # Postgres в docker
pnpm db:generate
pnpm db:migrate             # первая миграция
pnpm dev:api                # http://localhost:3000/health
pnpm dev:web                # http://localhost:5173
pnpm dev:admin              # http://localhost:5174
```
