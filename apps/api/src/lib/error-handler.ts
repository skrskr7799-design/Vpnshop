import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "./errors";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    // штатные ошибки Fastify и плагинов: 415, 429 и т.п.
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: (error as { code?: string }).code ?? "BAD_REQUEST" } });
    }
    req.log.error({ requestId: req.id, reasonCode: "UNHANDLED_REQUEST" });
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });
}
