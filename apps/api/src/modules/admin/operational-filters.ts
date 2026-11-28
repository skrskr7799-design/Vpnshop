import type { Prisma } from "@prisma/client";

export function stuckPayments(asOf: Date, warnSeconds = 900): Prisma.PaymentWhereInput {
  return { OR: [
    { status: "UNKNOWN" },
    { status: { in: ["SUBMITTING", "PROCESSING"] }, updatedAt: { lt: new Date(+asOf - warnSeconds * 1000) } },
  ] };
}

export function overdueJobs(asOf: Date, warnSeconds = 900): Prisma.FulfillmentJobWhereInput {
  return { status: { in: ["VERIFY_PENDING", "RETRY_WAIT", "PENDING"] },
    nextAttemptAt: { lt: new Date(+asOf - warnSeconds * 1000) } };
}

export function registrationCohort(from: Date, to: Date, paidInWindow = false): Prisma.UserWhereInput {
  const interval = { gte: from, lt: to };
  return {
    role: "USER", createdAt: interval,
    ...(paidInWindow && { orders: { some: { allocation: { is: { createdAt: interval } } } } }),
  };
}
