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

## Интеграция с Remnawave (`apps/api/src/modules/remnawave`)

Клиент написан по **официальному контракту** `@remnawave/backend-contract` (3.4.17 = панель 3.4.9, серия 3.4.x).
Проверить связь с вашей панелью (ничего не создаёт и не меняет): `pnpm --filter @vpn/api remnawave:check`.

**Как работает API 3.x (важно, отличается от старых сторонних SDK):**
- Пользователь адресуется числовым `id` или `username`, поля `uuid` нет. У нас `User.remnawaveUserId`.
- Ответ содержит готовый `subscriptionUrl`: ссылку строить не нужно.
- Все ответы приходят в обёртке `{ response: ... }`, авторизация `Authorization: Bearer <API-токен>`.
- За Caddy нужен `X-Api-Key` (`REMNAWAVE_API_KEY`); при прямом доступе по внутренней сети `REMNAWAVE_TRUSTED_PROXY_HEADERS=true`.
- Новым пользователям нужны internal squads (`REMNAWAVE_INTERNAL_SQUAD_UUIDS`).

**Выдача подписки идемпотентна** (`remnawave.provisioning.ts`): итоговая дата окончания считается один раз (`planExpiry`), сохраняется в `FulfillmentJob.targetExpireAt` и отправляется в панель абсолютным значением (`applySubscription`). Повтор после сбоя не удлиняет срок дважды. Запись клиент сам не повторяет, повторы делает задача.

**Лимит устройств** (`hwidDeviceLimit`) работает, только если включён в панели: Subscription → Settings → HWID Device Limit. По умолчанию он выключен. Подписку получают только клиенты, которые передают HWID.

**Лицензия:** `@remnawave/backend-contract` под AGPL-3.0. Он стоит как devDependency и используется только в тестах для сверки с контрактом; в рабочий код не попадает, клиент использует собственные схемы.

## Воркер выдачи подписок (`apps/api/src/modules/fulfillment`)

После оплаты заказ получает статус `PAID` и в той же транзакции ставится задача `enqueueFulfillment(tx, orderId)`. Воркер (внутри процесса API, `WORKER_ENABLED=true`) выдаёт подписку в Remnawave.
**Запускайте ровно один экземпляр воркера.**

**Как работает одна задача:**
1. Захват атомарный (compare-and-set), два воркера одну задачу не возьмут.
2. Задачи одного пользователя идут строго по очереди: следующая ждёт, пока завершится предыдущая. Иначе две задачи посчитали бы срок от одного состояния панели, и одна перезаписала бы другую.
3. Итоговая дата считается один раз и сохраняется в `FulfillmentJob.targetExpireAt`, в панель уходит абсолютным значением. Повтор после сбоя безопасен.
4. Результат (задача `DONE`, заказ `FULFILLED`, `User.remnawaveUserId`) пишется одной транзакцией.

**Сбои:**
- Панель недоступна: повтор с экспоненциальной паузой (15 сек … 30 мин), до 15 попыток (около 5 часов), затем `FAILED`.
- Неверный токен или версия панели: задача не сдаётся, опрашивается раз в 10 минут и выполнится сама после исправления настройки; в логах `error`.
- Панель отклонила запрос или заказ не в статусе `PAID`: сразу `FAILED`.
- Процесс упал посреди задачи: через 5 минут задача возвращается в очередь и безопасно дорабатывается.
- Пользователь отключён в панели вручную: срок продлевается, статус не меняется, в задаче остаётся пометка.

`FAILED` задачи нужно разбирать вручную: `requeueFailedJob(id)` вернёт задачу в очередь (для будущей админки).

## Интеграционные тесты (настоящий Postgres)

Покрывают код с БД: воркер, регистрацию, сессии, сброс пароля, объединение аккаунтов. Нужна отдельная БД с `test` в имени (иначе очистка откажется работать):

```bash
export TEST_DATABASE_URL=postgresql://vpnshop:vpnshop@localhost:5432/vpnshop_test
pnpm --filter @vpn/api db:test:push        # создаёт таблицы (внимание: стирает БД)
pnpm --filter @vpn/api test:integration
```

Обычный `pnpm test` их не запускает.

## Админка (`apps/api/src/modules/admin`)

Это **отдельный сервер** на своём порту (по умолчанию `127.0.0.1:3001`, выключен). Публичный API маршрутов админки не содержит вообще (проверяется тестом).
Включение: `ADMIN_ENABLED=true`, `ADMIN_ENCRYPTION_KEY` (`openssl rand -base64 32`), `ADMIN_ORIGIN` (адрес фронта админки). Наружу её выводит VPN или reverse proxy с ограничением по сети; дополнительно можно задать `ADMIN_ALLOWED_CIDRS`.

**Первый админ:**
```bash
pnpm --filter @vpn/api admin:create you@example.com          # пароль спросит скрытым вводом, не короче 12 символов
pnpm --filter @vpn/api admin:create helper@example.com --support   # роль только для просмотра
pnpm --filter @vpn/api admin:reset-2fa you@example.com       # потеряны телефон и резервные коды
```
При первом входе админка предложит подключить приложение-аутентификатор и выдаст 10 резервных кодов (показываются один раз).

**Защита:**
- Вход в два шага: пароль, затем обязательный TOTP-код. Токен между шагами живёт 5 минут и сессии не даёт.
- Код принимается один раз (повтор и параллельные запросы отсекаются), 5 неверных подряд блокируют ввод на 15 минут.
- Секрет TOTP хранится зашифрованным (AES-256-GCM), резервные коды только в виде хэшей.
- Сессии серверные: кука `vpn_admin` (httpOnly, SameSite=Strict) с случайным токеном. Бездействие 30 минут, абсолютный предел 12 часов. Роль и блокировка проверяются при каждом запросе, отзыв мгновенный.
- Изменяющие запросы принимаются только с `Origin` фронта админки. Адреса вне `ADMIN_ALLOWED_CIDRS` получают 404. `X-Forwarded-For` по умолчанию не учитывается (`ADMIN_TRUST_PROXY`).
- Ответы с `Cache-Control: no-store`. Все изменения пишутся в журнал **в той же транзакции**, что и само изменение (нет действия без записи).

**Роли:** `ADMIN` может всё, `SUPPORT` только смотрит тарифы, задачи и дашборд (без журнала и изменений). Права в `admin.permissions.ts`.

**API** (`/api/...`): `auth/login`, `auth/2fa/enroll/start`, `auth/2fa/enroll/confirm`, `auth/2fa/verify`, `auth/logout`, `me`, `dashboard`, `plans` (CRUD + `plans/:id/prices`), `jobs` (+ `jobs/:id/requeue`), `audit`.
