import { checkoutKeySchema, supportCategory, supportCreate, supportPriority, supportReply, supportStatus } from "@vpn/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { keysetQuery } from "../../lib/keyset";
import { adminOf, requireAdmin } from "../admin/admin.middleware";
import { authenticate } from "../auth/authenticate";
import { changeCustomerCase, listAssignees, listCases, markCaseRead, openCase, readCase, replyToCase } from "./support.service";

const params = z.strictObject({ id: z.uuid() });
const ownerQuery = keysetQuery.extend({ status: supportStatus.optional() });
const staffQuery = ownerQuery.extend({
  category: supportCategory.optional(), orderId: z.uuid().optional(), forUserId: z.uuid().optional(),
  priority: supportPriority.optional(), assigneeId: z.union([z.uuid(), z.literal("unassigned")]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
const detailQuery = keysetQuery.extend({ historyCursor: z.string().max(500).optional() });
const key = (req: FastifyRequest) => checkoutKeySchema.parse(req.headers["idempotency-key"]);
const boundedPost = { bodyLimit: 16_384, config: { rateLimit: { max: 8, timeWindow: "1 minute" } } };
const readPost = { bodyLimit: 2048, config: { rateLimit: { max: 40, timeWindow: "1 minute" } } };
const through = z.strictObject({ through: z.iso.datetime().transform(value => new Date(value)) });
const owner = (req: FastifyRequest) => ({ id: req.auth!.userId, isStaff: false });
const staff = (req: FastifyRequest) => ({ id: adminOf(req).userId, isStaff: true });

export const ownerSupportRoutes: FastifyPluginAsync = async app => {
  app.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "private, no-store"); });
  app.addHook("preHandler", authenticate);
  app.get("/me/support/cases", req => listCases(owner(req), ownerQuery.parse(req.query)));
  app.post("/me/support/cases", boundedPost, async (req, reply) =>
    reply.code(201).send(await openCase(req.auth!.userId, key(req), supportCreate.parse(req.body))));
  app.get("/me/support/cases/:id", req =>
    readCase(params.parse(req.params).id, owner(req), detailQuery.parse(req.query)));
  app.post("/me/support/cases/:id/messages", boundedPost, async (req, reply) =>
    reply.code(201).send(await replyToCase(req.auth!.userId, params.parse(req.params).id, key(req), supportReply.parse(req.body).message)));
  app.post("/me/support/cases/:id/status", boundedPost, req =>
    changeCustomerCase(req.auth!.userId, params.parse(req.params).id, key(req),
      z.strictObject({ action: z.enum(["close", "reopen"]) }).parse(req.body).action));
  app.post("/me/support/cases/:id/read", readPost, async (req, reply) => {
    await markCaseRead(owner(req), params.parse(req.params).id, through.parse(req.body).through);
    return reply.code(204).send();
  });
};

export const staffSupportRoutes: FastifyPluginAsync = async app => {
  app.get("/support/assignees", { preHandler: requireAdmin("support:read") }, listAssignees);
  app.get("/support/cases", { preHandler: requireAdmin("support:read") }, req =>
    listCases(staff(req), staffQuery.parse(req.query)));
  app.get("/support/cases/:id", { preHandler: requireAdmin("support:read") }, req =>
    readCase(params.parse(req.params).id, staff(req), detailQuery.parse(req.query)));
  app.post("/support/cases/:id/read", { ...readPost, preHandler: requireAdmin("support:read") }, async (req, reply) => {
    await markCaseRead(staff(req), params.parse(req.params).id, through.parse(req.body).through);
    return reply.code(204).send();
  });
};
