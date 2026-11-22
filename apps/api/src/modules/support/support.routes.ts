import { checkoutKeySchema, supportCategory, supportCreate, supportReply, supportStatus } from "@vpn/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { keysetQuery } from "../../lib/keyset";
import { requireAdmin } from "../admin/admin.middleware";
import { authenticate } from "../auth/authenticate";
import { listCases, openCase, readCase, replyToCase } from "./support.service";

const params = z.strictObject({ id: z.uuid() });
const ownerQuery = keysetQuery.extend({ status: supportStatus.optional() });
const staffQuery = ownerQuery.extend({ category: supportCategory.optional(), orderId: z.uuid().optional(), forUserId: z.uuid().optional() });
const detailQuery = keysetQuery.extend({ historyCursor: z.string().max(500).optional() });
const key = (req: FastifyRequest) => checkoutKeySchema.parse(req.headers["idempotency-key"]);
const boundedPost = { bodyLimit: 16_384, config: { rateLimit: { max: 8, timeWindow: "1 minute" } } };

export const ownerSupportRoutes: FastifyPluginAsync = async app => {
  app.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "private, no-store"); });
  app.addHook("preHandler", authenticate);
  app.get("/me/support/cases", req => listCases(req.auth!.userId, ownerQuery.parse(req.query)));
  app.post("/me/support/cases", boundedPost, async (req, reply) =>
    reply.code(201).send(await openCase(req.auth!.userId, key(req), supportCreate.parse(req.body))));
  app.get("/me/support/cases/:id", req =>
    readCase(params.parse(req.params).id, req.auth!.userId, detailQuery.parse(req.query)));
  app.post("/me/support/cases/:id/messages", boundedPost, async (req, reply) =>
    reply.code(201).send(await replyToCase(req.auth!.userId, params.parse(req.params).id, key(req), supportReply.parse(req.body).message)));
};

export const staffSupportRoutes: FastifyPluginAsync = async app => {
  app.get("/support/cases", { preHandler: requireAdmin("support:read") }, req =>
    listCases(undefined, staffQuery.parse(req.query)));
  app.get("/support/cases/:id", { preHandler: requireAdmin("support:read") }, req =>
    readCase(params.parse(req.params).id, undefined, detailQuery.parse(req.query)));
};
