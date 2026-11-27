import { synchronizeAdminPolicy } from "./modules/admin/auth/policy";
import { buildAdminApp } from "./modules/admin/admin-app";
import { env } from "./config/env";
import { listen } from "./lib/listener";

if (!env.ADMIN_ENABLED || env.MZT_PROCESS !== "admin") throw new Error("Admin process is disabled");
const app = await buildAdminApp({ panel: { async getMetadata() { throw new Error("Panel probe belongs to the worker"); } } });
await synchronizeAdminPolicy();
await listen(app, { host: env.ADMIN_HOST, port: env.ADMIN_PORT });
