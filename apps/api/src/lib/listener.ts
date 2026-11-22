import type { FastifyInstance } from "fastify";
import { prisma } from "./prisma";

export async function listen(app: FastifyInstance, options: { host: string; port: number }) {
  const stop = async () => {
    if (app.draining) return;
    app.draining = true;
    const deadline = setTimeout(() => process.exit(1), 27_000).unref();
    try { await app.close(); await prisma.$disconnect(); }
    catch { process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await app.listen(options); }
  catch { app.log.error({ reasonCode: "LISTEN_FAILED" }); process.exitCode = 1; await stop(); }
}
