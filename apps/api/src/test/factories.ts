import { randomUUID } from "node:crypto";
import type { OrderStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";

export const createUser = (data: { email?: string | null } = {}) =>
  prisma.user.create({ data: { email: data.email === undefined ? `u-${randomUUID()}@example.com` : data.email } });

export async function createOrder(
  userId: string,
  opts: { months?: number; deviceLimit?: number; status?: OrderStatus } = {},
) {
  const plan = await prisma.plan.upsert({
    where: { code: "starter" },
    create: { code: "starter", name: "Стартовый", deviceLimit: 5 },
    update: {},
  });
  return prisma.order.create({
    data: {
      userId,
      planId: plan.id,
      durationMonths: opts.months ?? 1,
      deviceLimit: opts.deviceLimit ?? 5,
      currency: "RUB",
      amount: 10_000,
      status: opts.status ?? "PAID",
      expiresAt: new Date(Date.now() + 3600_000),
      paidAt: new Date(),
    },
  });
}

// Задача с заданным временем создания: нужно, чтобы проверять порядок обработки
export const createJob = (orderId: string, createdAt?: Date) =>
  prisma.fulfillmentJob.create({ data: { orderId, ...(createdAt && { createdAt }) } });
