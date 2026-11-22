import { stagingPanel } from "./config/staging-panel";
import { buildApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { buildAdminApp } from "./modules/admin/admin-app";
import { remnawave } from "./modules/remnawave";

const app = await buildApp({ panel: stagingPanel(5_000)?.panel });

// Админка: отдельный сервер на своём порту. Маршрутов админки в публичном API нет вообще.
const adminApp = env.ADMIN_ENABLED ? await buildAdminApp({ panel: remnawave }) : null;

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
