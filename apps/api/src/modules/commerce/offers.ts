import type { OfferVersion, Plan, PlanPrice, Prisma } from "@prisma/client";
import type { Offer } from "@vpn/shared";
import { AppError } from "../../lib/errors";

export async function dbNow(db: Prisma.TransactionClient): Promise<Date> {
  const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  return row!.now;
}

// Staff commands take an exclusive lock in the same order as checkout's shared lock.
export async function lockPlanForEdit(db: Prisma.TransactionClient, id: string): Promise<Plan> {
  const [plan] = await db.$queryRaw<Plan[]>`SELECT * FROM "Plan" WHERE id = ${id} FOR UPDATE`;
  if (!plan) throw new AppError(404, "PLAN_NOT_FOUND");
  return plan;
}

export async function withdrawOffer(db: Prisma.TransactionClient, planPriceId: string, now: Date) {
  await db.offerVersion.updateMany({ where: { planPriceId, withdrawnAt: null }, data: { withdrawnAt: now } });
}

// Call while holding the plan lock. PlanPrice remains the editable offer and keeps its stable ID.
export async function publishOffer(db: Prisma.TransactionClient, plan: Plan, price: PlanPrice, now: Date) {
  const latest = await db.offerVersion.findFirst({ where: { planPriceId: price.id }, orderBy: { version: "desc" } });
  const terms = {
    name: plan.name, deviceLimit: plan.deviceLimit, durationMonths: price.durationMonths,
    currency: price.currency, amount: price.amount,
  };
  if (latest && latest.withdrawnAt === null && Object.entries(terms).every(([k, v]) => latest[k as keyof typeof terms] === v)) {
    return latest;
  }
  await withdrawOffer(db, price.id, now);
  return db.offerVersion.create({ data: {
    ...terms, planPriceId: price.id, version: (latest?.version ?? 0) + 1, publishedAt: now,
  } });
}

export function toOffer(version: OfferVersion, planId: string): Offer {
  return {
    id: version.id, offerId: version.planPriceId, planId, version: version.version, name: version.name,
    durationMonths: version.durationMonths, price: { currency: version.currency, amountMinor: version.amount },
    deviceLimit: version.deviceLimit, trafficLimitBytes: null, trafficStrategy: null, availableUntil: null,
  };
}
