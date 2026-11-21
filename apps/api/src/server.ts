import { buildApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { buildAdminApp } from "./modules/admin/admin-app";
import { createFulfillmentWorker } from "./modules/fulfillment";
import { checkPanelCompatibility, remnawave } from "./modules/remnawave";

const app = await buildApp();

// Админка: отдельный сервер на своём порту. Маршрутов админки в публичном API нет вообще.
const adminApp = env.ADMIN_ENABLED ? await buildAdminApp({ panel: remnawave }) : null;

const worker = env.WORKER_ENABLED
  ? createFulfillmentWorker({ api: remnawave, internalSquadUuids: env.REMNAWAVE_INTERNAL_SQUAD_UUIDS, log: app.log })
  : null;
worker?.start();

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await worker?.stop(); // дожидаемся текущей задачи
  await adminApp?.close();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  await adminApp?.listen({ host: env.ADMIN_HOST, port: env.ADMIN_PORT });
  // Проверка панели не блокирует запуск
  void checkPanelCompatibility(remnawave, app.log, env.REMNAWAVE_INTERNAL_SQUAD_UUIDS);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
