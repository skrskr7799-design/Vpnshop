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

## Auth по почте (`/api/auth/*`)

| Метод | Путь | Описание |
|---|---|---|
| POST | `/register` | `{email, password}` → всегда 202. Аккаунт создаётся только после подтверждения почты |
| POST | `/verify-email` | `{token}` → 204. Создаёт аккаунт |
| POST | `/login` | `{email, password}` → ставит httpOnly-куки, отдаёт `{user}` |
| POST | `/refresh` | ротация refresh-токена, 204 |
| POST | `/logout` | гасит сессию, 204 |
| POST | `/forgot-password` | `{email}` → всегда 202 |
| POST | `/reset-password` | `{token, password}` → 204, все сессии отзываются |
| GET | `/me` | текущий пользователь |

**Куки:** `vpn_at` (access JWT, 15 мин) и `vpn_rt` (refresh, 30 дней, путь `/api/auth`). Обе httpOnly, SameSite=Lax, Secure в production.

**Клиентский поток:** на `401 UNAUTHENTICATED` вызвать `/refresh` и повторить запрос один раз. На `401 REFRESH_RACE` просто повторить `/refresh`. На `401 INVALID_SESSION` отправить на страницу входа.

**Тестирование через curl:** изменяющие запросы требуют заголовок `Origin`, равный `WEB_ORIGIN`.

В dev без `SMTP_URL` письма со ссылками выводятся в лог API.

## Фронтенд (`apps/web`)

Маршруты: `/login`, `/register`, `/forgot-password` (только для гостей), `/verify-email` и `/reset-password` (ссылки из писем), `/account` (только для вошедших).

**Структура:** `api/` (fetch-клиент), `features/auth/` (запросы, хуки, guards, страницы), `components/` (UI, у каждого компонента свой `.css`), `styles/` (токены и база).

**Обновление сессии** (`api/client.ts`): на `401 UNAUTHENTICATED` клиент один раз вызывает `/auth/refresh` и повторяет запрос.
- Параллельные 401 в одной вкладке делят один refresh.
- Между вкладками refresh сериализуется через Web Locks, поэтому одноразовые refresh-токены не конфликтуют.
- `REFRESH_RACE` повторяется с паузой, сетевая ошибка не разлогинивает.
- При `INVALID_SESSION` кэш очищается и `RequireAuth` ведёт на `/login` с возвратом на исходную страницу.

**Настройка:** название бренда в интерфейсе задаётся `VITE_APP_NAME` в `apps/web/.env` (по умолчанию «VPN»). Токены из ссылок писем сразу убираются из адресной строки.

**Тесты:** `pnpm test` (клиент refresh, схемы, пароли, редиректы).

## Вход через Google и Telegram

Включается, только если в `.env` заданы пары ключей. Без них кнопки на фронте не появляются.
Оба провайдера работают по OIDC (code flow + PKCE), `id_token` проверяется по JWKS (подпись, issuer, audience, срок, nonce).

**Google:** Google Cloud Console → Credentials → OAuth client (Web application).
Authorized redirect URI: `<WEB_ORIGIN>/api/auth/oauth/google/callback`. Значения идут в `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`.

**Telegram:** @BotFather → бот → Login Widget. В Allowed URLs добавить `<WEB_ORIGIN>/api/auth/oauth/telegram/callback`.
Client ID и Client Secret BotFather показывает там же (`TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`). Telegram принимает только заранее зарегистрированные URL.

**Эндпоинты** (`/api/auth/oauth/*`): `GET /providers`, `GET /:provider/start`, `GET /:provider/link` (привязка к вошедшему), `GET /:provider/callback`, `GET /identities`.

**Объединение аккаунтов:**
1. Внешний аккаунт уже привязан → вход в его пользователя.
2. Google с подтверждённым email и пользователь с таким email уже есть → привязка к нему.
3. Иначе создаётся новый пользователь (у Telegram email нет).

Telegram-аккаунт к существующему профилю добавляется в «Аккаунт → Способы входа». Идентификатор Telegram берётся из клэйма `id`, он совпадает с id пользователя в Bot API (понадобится для оплаты Stars).
