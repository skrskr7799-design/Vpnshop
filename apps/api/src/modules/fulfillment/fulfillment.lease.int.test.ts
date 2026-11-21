import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createJob, createOrder, createUser } from "../../test/factories";
import { MAX_ATTEMPTS } from "./fulfillment.constants";
import {
  claimNextJob, closeJobAsAlreadyDone, completeJob, failJob, LeaseLost,
  renewLease, rescheduleJob, savePlannedExpiry,
} from "./fulfillment.queue";

beforeEach(async () => { await resetDatabase(); });

it("fences expiry, renewal and every stale write, including across different orders", async () => {
  const user = await createUser();
  const order = await createOrder(user.id);
  const first = await createJob(order.id);
  const lease = () => prisma.fulfillmentLease.findUniqueOrThrow({ where: { userId: user.id } });
  const claims = await Promise.all([claimNextJob("a", 60_000), claimNextJob("b", 60_000)]);
  const winners = claims.filter(job => job !== null);
  expect(winners).toHaveLength(1);
  const old = winners[0]!;
  expect(old.id).toBe(first.id);
  await renewLease(old, 120_000);
  expect((await lease()).expiresAt!.getTime()).toBeGreaterThan(Date.now() + 100_000);
  const goal = await savePlannedExpiry(old, new Date("2031-01-01T00:00:00Z"));

  // Even an older, backfilled order cannot overtake the account's active lease.
  const next = await createJob((await createOrder(user.id)).id, new Date(0));
  expect(await claimNextJob("c", 60_000)).toBeNull();
  await prisma.fulfillmentLease.update({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
  await expect(renewLease(old, 60_000)).rejects.toBeInstanceOf(LeaseLost);
  const current = (await claimNextJob("c", 60_000))!;
  expect(current).toMatchObject({ id: first.id, attempts: 2, targetExpireAt: goal, generation: old.generation + 1n });
  for (const staleWrite of [
    () => renewLease(old, 60_000), () => savePlannedExpiry(old, new Date(0)),
    () => rescheduleJob(old, new Date(), "stale"), () => failJob(old, "stale"),
    () => closeJobAsAlreadyDone(old, new Date()), () => completeJob(old, { remnawaveUserId: 9 }, new Date()),
  ]) await expect(staleWrite()).rejects.toBeInstanceOf(LeaseLost);
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID" });
  expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ remnawaveUserId: null });
  expect(await savePlannedExpiry(current, new Date(0))).toEqual(goal);
  await completeJob(current, { remnawaveUserId: 42 }, new Date());
  expect(await claimNextJob("a", 60_000)).toMatchObject({ id: next.id, generation: current.generation + 1n });
  await expect(failJob(current, "late")).rejects.toBeInstanceOf(LeaseLost);
});

it("rejects writes by the legacy claim and reaper; crash loops end in FAILED", async () => {
  const user = await createUser();
  const order = await createOrder(user.id);
  const job = await createJob(order.id);
  const update = (status: "PENDING" | "RUNNING") => prisma.fulfillmentJob.update({ where: { id: job.id }, data: { status } });
  await expect(update("RUNNING")).rejects.toThrow("lease protocol");
  await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { attempts: MAX_ATTEMPTS - 1 } });
  expect(await claimNextJob("dying", 60_000)).toMatchObject({ attempts: MAX_ATTEMPTS });
  await expect(update("PENDING")).rejects.toThrow("lease protocol");
  await prisma.fulfillmentLease.update({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
  expect(await claimNextJob("recovery", 60_000)).toBeNull();
  expect(await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
    status: "FAILED", attempts: MAX_ATTEMPTS, lockedAt: null,
  });
});
