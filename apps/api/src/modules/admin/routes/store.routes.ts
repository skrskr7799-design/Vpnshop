import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../../lib/errors";
import { keysetPage, keysetQuery, keysetWhere, newestFirst } from "../../../lib/keyset";
import { prisma } from "../../../lib/prisma";
import { requireAdmin } from "../admin.middleware";
import type { Permission } from "../admin.permissions";

type Execute = (req: FastifyRequest, operation: string, targetId: string) => Promise<unknown>;
const uuid = z.uuid();
const id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id;
const defaultSettings = { version: 0, subscriptionLinkAllowed: true, fulfillmentLagWarnSeconds: 900, paymentLagWarnSeconds: 900 };

export function registerStoreRoutes(app: FastifyInstance, execute: Execute) {
  // Named routes and generic dispatch share the same auth, normalized command and audit.
  const routes: [string, string, Permission, ((req: FastifyRequest) => string)?][] = [
    ["/plans", "plan.create", "plans:write", req => z.object({ command: z.object({ code: z.string() }) }).parse(req.body).command.code],
    ["/plans/:id/offers", "plan.publish", "plans:write"],
    ["/plans/:id/offers/:offerId/retire", "plan.retire_offer", "plans:write"],
    ["/plans/:id/retire", "plan.retire", "plans:write"],
    ["/users/:id/account-status", "user.account_status", "users:write"],
    ["/users/:id/service-holds", "user.hold", "access:write"],
    ["/users/:id/service-holds/:holdId/release", "user.release_hold", "access:write"],
    ["/users/:id/reconcile-access", "user.reconcile_access", "jobs:write"],
    ["/users/:id/panel-binding/review", "user.binding_review", "bindings:write"],
    ["/users/:id/compensations", "subscription.compensate", "subscription:adjust"],
    ["/jobs/:id/requeue", "job.requeue", "jobs:write"],
    ["/orders/:id/reconcile", "order.reconcile", "finance:reconcile"],
    ["/orders/:id/refunds", "refund.request", "finance:refund"],
    ["/orders/:id/refunds/:refundId/approve", "refund.approve", "finance:refund"],
    ["/staff/invitations", "staff.invite", "staff:write", req => z.object({ command: z.object({
      email: z.email().transform(value => value.toLowerCase()),
    }) }).parse(req.body).command.email],
    ["/staff/:id/role", "staff.role", "staff:write"],
    ["/staff/:id/sessions/:sessionId/revoke", "staff.session.revoke", "staff:write"],
    ["/staff/:id/totp-reset-requests", "staff.totp.request", "staff:write"],
    ["/staff/:id/totp-reset-requests/:requestId/approve", "staff.totp.approve", "staff:write"],
    ["/support/cases/:id/actions", "support.action", "support:write"],
  ];
  for (const [path, operation, permission, target = id] of routes) {
    app.post(path, { preHandler: requireAdmin(permission) }, req => {
      const params = req.params as Record<string, string> | undefined;
      for (const field of ["offerId", "holdId", "refundId", "sessionId", "requestId"]) {
        if (params?.[field] !== undefined) {
          const body = z.object({ command: z.record(z.string(), z.unknown()) }).parse(req.body);
          if (body.command[field] !== uuid.parse(params[field])) throw new AppError(400, "INVALID_TARGET");
        }
      }
      return execute(req, operation, target(req));
    });
  }
  app.patch("/operations/settings", { preHandler: requireAdmin("settings:write") },
    req => execute(req, "settings.update", "default"));
  app.get("/operations/settings", { preHandler: requireAdmin("settings:write") }, async () => {
    const row = await prisma.adminOperationalSettings.findUnique({ where: { id: "default" } });
    return row ?? defaultSettings;
  });
  app.get("/orders/:id/refunds", { preHandler: requireAdmin("finance:read") }, async req => {
    const orderId = id(req);
    if (!await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })) throw new AppError(404, "NOT_FOUND");
    const { limit, cursor } = keysetQuery.parse(req.query);
    const scope = "admin-refunds:" + orderId;
    const rows = await prisma.refundIntent.findMany({ where: {
      capture: { payment: { orderId } }, ...keysetWhere(scope, cursor),
    }, select: { id: true, amountMinor: true, currency: true, createdAt: true, expiresAt: true, approvedAt: true,
      initiatorId: true, approvedBy: true,
    }, orderBy: newestFirst, take: limit + 1 });
    const now = new Date();
    return keysetPage(scope, rows, limit, row => ({
      ...row, amountMinor: row.amountMinor.toString(), status: row.approvedAt ? "APPROVED_WAITING_PROVIDER"
        : row.expiresAt > now ? "AWAITING_APPROVAL" : "EXPIRED",
    }));
  });
}
