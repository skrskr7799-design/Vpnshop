import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { keysetPage, keysetQuery, keysetWhere, newestFirst } from "../../lib/keyset";
import { prisma } from "../../lib/prisma";
import { authenticate } from "../auth/authenticate";

export async function listCustomerNotices(userId: string, { limit, cursor }: z.infer<typeof keysetQuery>, scope: "customer" | "staff") {
  const key = `${scope}-notices:${userId}`;
  const rows = await prisma.customerNotice.findMany({
    where: { userId, ...keysetWhere(key, cursor) },
    select: { id: true, title: true, body: true, createdAt: true, readAt: true },
    orderBy: newestFirst, take: limit + 1,
  });
  return keysetPage(key, rows, limit, row => row);
}

export const ownerNoticeRoutes: FastifyPluginAsync = async app => {
  app.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "private, no-store"); });
  app.addHook("preHandler", authenticate);
  app.get("/me/notices", req => listCustomerNotices(req.auth!.userId, keysetQuery.parse(req.query), "customer"));
  app.get("/me/notices/unread", async req => ({
    unread: await prisma.customerNotice.count({ where: { userId: req.auth!.userId, readAt: null } }),
  }));
  app.post("/me/notices/:id/read", { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(req.params);
    const userId = req.auth!.userId;
    const result = await prisma.customerNotice.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (!result.count && !await prisma.customerNotice.findFirst({ where: { id, userId }, select: { id: true } })) {
      throw new AppError(404, "NOT_FOUND");
    }
    return reply.code(204).send();
  });
};
