# Проверки и тестирование VPNShop

Phase 5. До коммерческого запуска каждый обязательный инвариант должен иметь проверку, среду и артефакт результата. [Платежи](payments.md) · [Подписки](subscriptions.md) · [Remnawave](remnawave-integration.md) · [Identity](identity.md)

## Существующие проверки

| Уровень | Точка входа | Что требуется |
|---|---|---|
| Установка и сборка | Node `>=22`, pnpm `12.21.0`, `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm typecheck`, `pnpm build`. Lockfile разрешает Prisma CLI и Client 6.19.3. API собирается tsup, frontend — Vite. | Typecheck отдельно от сборки. Lint script, Dockerfile и workflow отсутствуют. Чистый runner и точный runtime digest нужны для допуска. [Скрипты](../package.json) · [API](../apps/api/package.json) · [Lockfile](../pnpm-lock.yaml) |
| Unit и contract | `pnpm test`, Vitest. Unit исключает `*.int.test.ts`. Web проверяет transport/redirect в Node. Контракт панели закреплён на `@remnawave/backend-contract@3.4.17`. | Использовать существующие моки и проверки. Добавить DTO/permissions, financial fixtures и browser smoke. [API Vitest](../apps/api/vitest.config.ts) · [Web Vitest](../apps/web/vitest.config.ts) · [Контракт Remnawave](../apps/api/src/modules/remnawave/remnawave.contract.test.ts) |
| Интеграция | `pnpm --filter @vpn/api test:integration` создаёт временное окружение PostgreSQL 17. Пять прикладных наборов и тест защиты БД выполняются на ограниченной роли последовательно по файлам. | FND-02 проверяет чистую установку, отказ при drift, принятие исторической схемы с 15 синтетическими записями, два deploy и контрольные суммы. Отсутствующий файл сценариев, пустой набор или skipped assertion останавливают задание. [Скрипт](../apps/api/scripts/integration/run.sh) · [Инструкция](deployment.md#принятие-baseline-fnd-02) |

Фаза 1 зафиксировала 117 прошедших unit/contract тестов, HTTP 403 при загрузке Prisma engine, отказ API typecheck и 0 исполненных DB assertions. Фаза 3 отдельно подтвердила 40 локальных тестов Remnawave. Здесь команды проверены статически. [Фаза 1](audit.md#выполненные-технические-проверки) · [Фаза 3](remnawave-integration.md#что-делает-vpnshop-сегодня)

## Проверки CI и допуск релиза

| Проверка | PR и релиз | Среда, результат, зависимость |
|---|---|---|
| 1. Toolchain и locked install | Обязательно | Чистый runner, Node 24 LTS с точным patch и архитектурой, pnpm 12.21.0. `CI=true pnpm install --frozen-lockfile`. Версии и hash lockfile в отчёте. |
| 2. Prisma generate | Обязательно | `pnpm db:generate` после install. Согласованные client/CLI, engine commit и target. DB процесс для генерации не требуется. 403 и ошибка целостности блокируют gates. |
| 3. Typecheck | Обязательно | `pnpm typecheck` по workspace с реально сгенерированным Client. Любой TS error блокирует. |
| 4. Lint | Обязательно в целевом CI | Единый lint script с TS, границами импортов, параметризацией SQL и запретом server credentials во frontend. Пока отсутствует, требование остаётся открытым. Новые нарушения блокируют. |
| 5. Build | Обязательно | `pnpm build` после generate. Оба frontend и backend entrypoints, отсутствие secrets/source env в dist. |
| 6. Unit | Обязательно | `pnpm test`, часы и fixtures, без живых интеграций. Нулевой набор и skipped обязательные проверки блокируют. |
| 7. Integration | Обязательно | PostgreSQL 17, применённые миграции, `test:integration`. Для конкуренции — независимые соединения/процессы. Migration PR также проверяет legacy fixture, релиз репетирует на контролируемой копии. |
| 8. API contract | Обязательно | Pinned Remnawave, local HTTP mocks платёжных адаптеров, Fastify inject для DTO/guards и OAuth/Telegram fixtures. Реальная стендовая панель и sandbox провайдера проверяются при допуске интеграции и смене версии. |
| 9. Security | Обязательно | Secret scan, locked dependency/runtime audit, SBOM и image scan. Секрет блокирует всегда, High/Critical в runtime блокируют до исправления или ограниченного по времени согласованного исключения. Сбой scan означает pending/failed. [Угрозы](security.md#границы-доверия-и-угрозы) |
| 10. Docker build | Обязательно после появления Dockerfile | PR строит локальные образы и проверяет загрузку Prisma/Argon2. Доверенный релиз публикует digest, SBOM и provenance. Базовые образы по digest, Actions по SHA, permissions по job. |
| 11. Smoke | Обязательно | PR: ephemeral Compose с mocks, оба origin, readiness и рестарт. Перед релизом: кандидат по тому же digest на staging, sandbox checkout/выдача. Будущий production smoke использует чтения и probes. [Runbook](operations.md#релиз-и-откат) |

После generate параллельны lint, typecheck, build, unit/contracts и DB integration. Scan и smoke зависят от image build. Ветка защищена обязательными checks. Fork PR не получает секреты registry/deploy. Job релиза запускается с доверенного ref и манифестом кандидата. Артефакты содержат commit, версии, число тестов, миграции и безопасные ошибки. При flaky сценарии установить причину, сырое успешное rerun не является исправлением.

**База тестов.** Один disposable DB service/namespace на job, отдельная роль, production egress запрещён. До первой записи проверить ожидаемые hostname/dbname и маркер созданного CI-экземпляра. Применить `prisma migrate deploy`, затем fixtures. Тестовый runtime не владелец схемы. Файлы общей БД сохраняют `fileParallelism: false`. Очистка удаляет одноразовый ресурс. Подстрока test в URL недостаточна для проверки. [Миграции](deployment.md#postgresql-и-миграции)

### Генерация Prisma после HTTP 403

1. Зафиксировать согласованные CLI/Client 6.19.3 по lockfile, engine commit из metadata и точный binary target с учётом ОС/arch/libc/OpenSSL. Начальный API runtime — Debian/glibc и закреплённый Node 24 LTS. Postgres Alpine отдельный образ. Генерация в ABI-совместимом build stage. Загрузка клиента и SELECT 1 проверяются в собранном runtime.
2. Разрешить официальный CDN `binaries.prisma.sh` и утверждённый npm registry в CI. Проверить холодную установку, разрешённые postinstall hooks и явную generate. Холодный запуск должен получить engine и его контрольные суммы по TLS. Подтверждена ошибка 403 на загрузке engine/checksum, точный источник запрета Phase 1 не локализовал.
3. При недоступном CDN — утверждённое HTTPS зеркало неизменённых официальных файлов и checksum через `PRISMA_ENGINES_MIRROR` после проверки поддержки в используемой версии. Зеркало заполняется доверенным runner с исходным доступом. Записать commit, target и upstream checksum, проверить сверку после переноса. Кэш ключуется версиями, commit, target и lock hash. Холодная генерация с официального источника или утверждённого зеркала обязательна.
4. При 403 возвращать ошибку с безопасной диагностикой. TLS и checksum проверки остаются обязательными, сгенерированный клиент используется в typecheck и интеграционных тестах. Случайный сторонний engine, fake client и пропуск проверок не допускаются. [Исходный результат](audit.md#выполненные-технические-проверки) · [Lifecycle allowlist](../pnpm-workspace.yaml)

## Матрица критических сценариев

Среды: **U** — unit с фиксированными часами, **DB** — PostgreSQL 17 и миграции, **M** — локальные управляемые HTTP mocks, **S** — изолированный Compose staging, **B** — браузер на S, **R** — стендовая Remnawave и тестовый VPN-клиент, **P** — sandbox провайдера. Последняя колонка задаёт условие прохождения. Ошибки проверяются по durable состоянию и счётчику побочных эффектов. P/R нужны только для допуска релиза или изменения соответствующего контракта.

### Финансовые операции

| Уровень и среда | Предусловие | Действие | Ожидаемый результат и инвариант |
|---|---|---|---|
| Integration DB+M | Открытый заказ, проверенное подтверждение | Доставить тот же webhook параллельно и после потери ACK. | Один capture, allocation, grant и задача. ACK только после durable commit. |
| Integration DB+M | Две попытки одного заказа | Подтвердить два внешних capture. | Оба факта сохранены. Один зачтён, второй виден в сверке. Один grant. |
| Contract, DB+M | Источник проверен, сумма не совпадает | Доставить движение. | Подтверждённый факт в разборе без зачёта и выдачи. |
| Contract, DB+M | Источник проверен, валюта отличается | Доставить движение. | Валюта сохраняется, автоматический зачёт невозможен. |
| Integration DB+M | Истёкшие заказы | Сравнить своевременный capture с поздним уведомлением и фактически поздний capture. | Своевременный учитывается по Phase 2. Поздний уходит на разбор. Время прихода webhook не меняет границу. |
| Integration DB+M | Create/refund на стороне провайдера, потерян ответ | Повторить intent и сверку. | UNKNOWN до доказательства, тот же merchant reference, один внешний эффект. |
| Integration DB+M | Capture с доступным остатком | Подтвердить частичный refund, повторить webhook и конкурентный запрос. | Одно движение, лимит защищён резервом, право меняется через корректировку. |
| Integration DB+M | Полный возврат до начала периода | Подтвердить отмену и запустить гонку с выдачей. | История capture сохранена, цель пересчитана, старая revision не подтверждается. |
| Integration DB+M | Два последовательных периода | Вернуть деньги за первый после продления. | Условия второго сохранены, дополнительного grant нет. |
| Release S+P | Тестовый мерчант | Checkout, callback, тестовый refund и отчёт. | Суммы и reference совпадают по выписке и журналу. Replay страницы не добавляет фактов. [Платежи](payments.md#особые-случаи-и-доказательства-приёмки) |

### Подписки и панель

| Уровень и среда | Предусловие | Действие | Ожидаемый результат и инвариант |
|---|---|---|---|
| Integration DB+M | Первый подтверждённый заказ | Создать grant, профиль и прочитать результат. | Одна привязка, grant и совпавшая revision. До read-back доступ ожидается. |
| U и DB+M | Действующий доступ, конец месяца | Продлить на 1/3/6 месяцев при фиксированных часах. | Начало от оплаченного конца, UTC календарь, срок не сокращается, лимит вступает на границе. |
| U и DB+M | Истёкшее право | Зачесть новую покупку и применить. | Новый интервал по правилу Phase 2, прежний разрыв сохранён. |
| Integration DB+M | Период и сохранённый target | Повторить grant, job и HTTP. | Тот же ID, тот же абсолютный срок. |
| Integration DB+M | Два заказа, два worker, >25 заблокированных предшественников | Конкурентно продлить, захватить другой готовый job, поздно завершить старый вызов. | Два законных интервала. Готовый job захвачен. Старый token не коммитит, drift вызывает сверку. |
| Integration DB+M | Управляемый timeout | Потерять ответ с эффектом и без эффекта. | VERIFY_PENDING, чтение раньше повтора, отсутствие двойного начисления. |
| Fault injection DB+M | Worker держит lease | Остановить до HTTP, после внешней записи до commit и после DB commit. | Durable состояние переживает stop, verify-first и token защищают актуальную цель. |
| Integration DB+M | DISABLED/MISSING при действующем праве | Ручное изменение во время очереди. | Запись удержана, ссылка закрыта, право сохранено, автоматического снятия нет. |
| Integration DB+M | Внешний профиль расходится после CONFIRMED | Запустить скан due. | Расхождение видно по observedAt, применяется только актуальная цель при доказанной привязке. |
| Release S+R | Точная версия панели, назначенные группы и HWID | Создать, продлить, импортировать конфиг, подтвердить отключение. | Применяется проверенный контракт, клиент подключается, выключение и лимит проверены, секреты не попадают в отчёт. [Приёмка](remnawave-integration.md#план-контрактных-испытаний-и-критерии-допуска) |

### Авторизация и безопасность

| Уровень и среда | Предусловие | Действие | Ожидаемый результат и инвариант |
|---|---|---|---|
| API DB | Гость и два владельца | Запросить закрытый маршрут, чужой заказ, попытку, дело и конфигурацию. | 401 гостю, нейтральный 404 на чужой ID, нет эффекта и секрета. |
| API DB, S | USER/SUPPORT/ADMIN, разные origins | Вызвать admin write с недостаточной ролью или без корректного proof/причины. | Отказ сервера и ноль эффектов, безопасный аудит. |
| U и API DB | Enrollment и recovery | Неверный код, повтор TOTP/recovery и конкурентное подтверждение. | Срабатывают лимиты, только одно потребление, одна сессия. |
| API DB, B | Несколько устройств и семейства | Logout/revoke/reset. Использовать отозванный access и старый refresh. | Немедленный отказ для отозванной family, нет второго refresh, reuse закрывает family по политике. |
| API DB, B | Cookie и разные origins | Межисточниковая мутация и повтор callback. | 403 для CSRF, intent одноразовый, после logout привязка отклонена. |
| API DB+M | Команда hold/refund, idem key, step-up | Повтор после потери ответа, затем другой target/body или версия. | Тот же commandId при точном повторе, изменённая команда отклонена, эффект атомарен с аудитом. Refund одобряет второй ADMIN. |
| Contract/B/S | Synthetic OAuth/initData и VPN URL | Истечение, повтор, смена сессии, показ QR. | Только допустимые подпись и владелец, no-store, секрет отсутствует в кэше, логах и telemetry. [Identity](identity.md#http-контракты-identity) |

### Инфраструктура

| Уровень и среда | Предусловие | Действие | Ожидаемый результат и инвариант |
|---|---|---|---|
| Smoke S | Пустой VPS-эквивалент, pinned образы | Применить миграции, запустить и проверить порты/origins. | Корректные probes, изоляция PostgreSQL и admin. |
| Migration S | Старая схема, контрольные итоги | Expand и повтор backfill. Проверить старый и новый runtime. | Целостность, нет двойных фактов, locks и длительность укладываются в окно. |
| Fault injection S | Disposable DB и тестовая миграция | Имитировать ошибку миграции. | Rollout остановлен, фактическая схема доказана, безопасный откат образа или forward fix. |
| Recovery S | Backup + WAL, checkpoint и mock выписки | Восстановить отдельно, replay отчёта дважды, сверить панель. | RPO/RTO измерены, старые lease и сессии погашены. Один набор денежных фактов и периодов. |
| Fault injection S+M | API, DB и активная выдача | Перезапустить контейнер, остановить PostgreSQL, вернуть DB. | Liveness отвечает, readiness 503 до восстановления. Не начинается новая внешняя запись, worker продолжает после чтения. |
| Fault injection S+M | DB работает, due очередь | Остановить тестовую панель, вернуть после retry. | API ready, ссылка закрыта, paid/pending видны, очередь сходит без новых периодов. Сигналы получены. |
| Release S | Новый и предыдущий совместимый digest | Обновить, выполнить smoke и учебный rollback. | TLS, схема, роли, heartbeat и финансовая цепочка совпадают с ожиданиями, один активный писатель. [Runbook](operations.md#релиз-и-откат) |

Готовность подтверждают обязательные checks на холодном runner, воспроизводимый DB suite, staging smoke и отдельный протокол restore. Для допуска Telegram дополнительно нужен тестовый бот. [Критерии Phase 4](identity.md#приёмка-и-решения-для-владельца)

## Регрессия COM-02

`test:integration` использует disposable PostgreSQL и детерминированный payment fixture. Проверки охватывают конкурирующие команды создания, PostgreSQL backend PID, таймаут и восстановление intent без второго POST, BOLA, состояние после durable ACK, параллельный webhook и pull, конфликт event key, append-only ledger, двойное поступление, опоздание, обратное движение до оригинала, несовпадение суммы/валюты и закрытую выдачу. Повторный clean/legacy migrate сравнивает исторические поля Order, Payment и WebhookEvent и проверяет пустой новый журнал. Реальный sandbox потребует отдельных доказательств, включая точный wire-format, redirect, timeout, аутентификацию, ACK и внешний lookup. [Integration suite](../apps/api/src/modules/payments/payments.int.test.ts) · [Capability matrix](payments.md#com-02-и-platega)

## Регрессия COM-03

PostgreSQL suite проверяет повтор и конкуренцию зачёта, два merchant lock и два независимых backend PID, запрет пересечения, откат до commit, UTC v1, связанные обратные движения и ожидающий inbox, полный/частичный возврат, независимые hold, сценарий R03, смену лимита на границе и восстановление пропущенной границы. Отдельный worker process в обычном режиме тестируется с loopback-счётчиком HTTP. Legacy rehearsal дважды применяет миграции/идемпотентный backfill, проверяет 15 исходных записей, пустую непроверенную подписку и отклонение старого writer. [Subscription suite](../apps/api/src/modules/subscriptions/subscriptions.int.test.ts)

## Регрессия COM-04

Публичный CI использует pinned TypeScript-контракт, loopback HTTP-сервер и disposable PostgreSQL. Проверяются разные соединения и владение lease, неоднозначный create, восстановление после внешней записи, устаревший HTTP после подтверждённого запрета, планирование повторной сверки, drift при CONFIRMED, конфликт имени/ID, ручной DISABLED, C4 после commit удержания, смена лимита и будущая граница после разрыва. Реальная сеть панели не участвует. [Интеграционные проверки](../apps/api/src/modules/fulfillment/revision.int.test.ts) · [HTTP contract](../apps/api/src/modules/remnawave/remnawave.http.contract.test.ts)

## Проверки кабинета ACC-01–03

- PostgreSQL в существующем Toolchain CI покрывает ротацию и гонку refresh, два устройства, revoke, reset и попытку reset staff, callback replay, явную OIDC-привязку, C1–C7 ownership, статусы позднего платежа и сверки, C4 при hold и отзыве во время чтения панели, C8–C11 ownership, конкурентную дедупликацию, ограничения сообщения и A13. Репетиции clean/legacy включают повторный deploy и сравнение 15 исходных записей. [Интеграционный runner](../apps/api/scripts/integration/run.sh)
- Для браузерного smoke собрать `pnpm --filter @vpn/web build`, затем выполнить `node apps/web/scripts/account-browser-smoke.mjs` с Chromium в PATH или указать `CHROMIUM_BIN`. Скрипт запускает изолированный профиль и loopback HTTP с синтетическими DTO. Проверяются 360 px, checkout с потерянным ответом и тем же ключом, помощь по заказу, безопасное отображение HTML как текста, локальный QR и закрытие приватного UI при неподтверждённом logout.
- Браузерный smoke и PostgreSQL проверяют разные границы. Реальная доставка почты, OAuth Google/Telegram, Platega и Remnawave остаются отдельными стендовыми проверками. Успешный synthetic run не подтверждает доступность провайдера.

## Проверки ADM-01–03

- PostgreSQL проверяет одноразовый enrollment и challenge, второй фактор и recovery, отзыв и ролевой периметр, expiry подтверждения под блокировкой, идемпотентность, rollback при сбое аудита, конкурентную публикацию, независимые Hold, устаревшую revision, возвратный резерв с другим approver и уникальную компенсацию. CI сохраняет clean/legacy и regression gates FND, COM и ACC.
- Операторские проекции проверяются на 1001 строке с одинаковым timestamp. Проверяются область курсоров, маскировка SUPPORT, суммы по валютам и видам подтверждённых движений, цепочка заказа до наблюдения и состояния stale/unavailable.
- После pnpm build команды node apps/admin/scripts/admin-browser-smoke.mjs и node apps/web/scripts/account-browser-smoke.mjs запускают Chromium с изолированным loopback HTTP. Можно указать CHROMIUM_BIN. Admin smoke проверяет вход, клавиатуру, ширину 360 px, свежесть, повтор команды после ошибки, изоляцию SUPPORT и отрисовку сообщения как текста.

## Инфраструктурные проверки OPS

| Проверка | Как воспроизвести |
|---|---|
| Сборка, ABI и конфигурация | `ops/scripts/build.sh` собирает семь targets из pinned bases через locked install. Node и native engine используют Debian bookworm и OpenSSL. `ops/scripts/smoke.sh` запускает реальный Prisma с DB grants и Argon2 при синтетической регистрации. |
| Сеть, TLS, секреты | Compose smoke поднимает изолированный стек с локальным CA, проверяет оба origins, SPA, неверный SNI, spoofed forwarding, недоступные порты, UID, secret mounts и утечку marker. Публичный Actions выполняет всё с одноразовыми секретами. |
| Migration и drain | Cold DB, повторный migrate deploy, искусственная запись о failed migration и восстановление readiness после её удаления, graceful SIGTERM, регрессии миграций и worker в основном CI. |
| Метрики и алертинг | promtool, amtool, DB exporter и синтетическое уведомление в закрытый HTTP sink. |
| Backup/PITR | `ops/scripts/pitr.sh` проверяет pgBackRest, UTC PITR, PostgreSQL, историю Prisma и синтетический replay. Вариант `MZT_DRILL_REPO=s3` поднимает TLS-прокси, локальный S3 API и проверяет encrypted logical dump, скачивание и SHA-256. Локальный режим `MZT_DRILL_SQL_ONLY=1` применяет migration SQL напрямую и не подтверждает таблицу истории Prisma. |
| Staging | Повторить restore из реального TLS S3 с recovery materials, compatibility rollback, VPN/firewall IPv4/IPv6, SMS/email/alert delivery по согласованным каналам, RPO/RTO и нагрузку. Доступы Platega и Remnawave отдельно. |

[Infrastructure workflow](../.github/workflows/infrastructure.yml) · [Восстановление](operations.md#практический-drill-и-off-site)


## Визуальная приёмка UX-01–03

Собрать оба frontend, установить MZT_VISUAL_DIR на пустой каталог и запустить оба browser-smoke скрипта с Chromium. Без переменной выполняются функциональные сценарии. Toolchain CI публикует кадры и JSON как mzt-visual-<sha>.

- Проверяются 320, 360, 375, 390, 430, 768, 1024, 1440, 1920 CSS px. Для каждого экрана проверяется заголовок, именование видимых полей, минимум 44 px для основных контролов и отсутствие горизонтального overflow страницы. Таблицы прокручиваются локально. Операторский fixture содержит 1 010 записей, на странице не больше 25.
- Проверяются Tab, Escape, возврат фокуса и accessible name модального checkout, контраст выбранных пар токенов, reflow при 200% zoom и reduced motion. Полный аудит WCAG и отдельный скринридер остаются частью релизной приёмки.
- qa.json содержит gzip размеры, результат viewport sweep и три холодных замера login/dashboard при 390 px, CPU 4×, RTT 150 мс и 1,6 Мбит/с. Это синтетические LCP, CLS и transfer. Полевой INP не измеряется этим тестом.
- Кадры используют только синтетические данные. На экране подключения ссылка и QR закрыты. PostgreSQL, API и инфраструктура проверяются отдельно. [Workflow](../.github/workflows/ci.yml) · [Сценарий](../scripts/visual-qa.mjs)

## REL · Проверка связного кандидата

Toolchain CI запускает customer/admin journey против настоящего PostgreSQL и реальных HTTP handlers с локальными провайдерами. Путь объединяет регистрацию, одноразовое письмо, логин, публикацию и checkout, повтор webhook, одну запись своего CAPTURE, одну allocation, grant, worker, владельческую выдачу, продление, поддержку, Hold, независимое одобрение возвратного intent и отзыв сессии. Сценарии истечения, UNKNOWN, двух capture, stale revision и гонок проверяются специализированными suite из COM, ACC и ADM. [Связный сценарий](../apps/api/src/test/release-journey.int.test.ts)

Infrastructure verification повторяет HTTP/TLS на образах-кандидатах, scoped grants, выкладку предыдущего runtime на той же схеме, остановку БД, SIGTERM/SIGKILL, восстановление доступности и durable retry SMTP. Полный и differential restore проверяют UTC target, migration history, checksum и отсутствие дублей. CSP из edge применяется также к Chromium HTTP fixture. [Инфраструктура](../.github/workflows/infrastructure.yml) · [Матрица допуска](release-acceptance.md)
