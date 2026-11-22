import { buildApp } from "./app";
import { env } from "./config/env";
import { stagingPanel } from "./config/staging-panel";
import { listen } from "./lib/listener";

const app = await buildApp({ panel: stagingPanel(5000)?.panel });
await listen(app, { host: env.HOST, port: env.PORT });
