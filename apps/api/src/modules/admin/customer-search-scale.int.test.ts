import { expect, it } from "vitest";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { as, buildTestAdminApp, createEnrolledAdmin } from "./admin.test-helpers";

it("finds exact customer references under a 100,000-row workload per entity", async () => {
  await resetDatabase();
  const app = await buildTestAdminApp();
  try {
    const actor = await createEnrolledAdmin("benchmark-admin@example.invalid", "ADMIN");
    const api = as(app, actor.sessionToken);
    const id = (prefix: number, index: number) => `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const count = 100_000;
    const index = 90_000;
    await prisma.$transaction(async db => {
      await db.$executeRaw`
        INSERT INTO "User"(id,email,"emailVerifiedAt","displayName","updatedAt")
        SELECT '10000000-0000-4000-8000-'||lpad(i::text,12,'0'), 'bench-'||i||'@example.invalid',
          now(), 'Bench client '||i, now() FROM generate_series(1,${count}) AS s(i)`;
      const plan = await db.plan.create({ data: { code: "benchmark", name: "Benchmark", deviceLimit: 3 } });
      await db.$executeRaw`
        INSERT INTO "Order"(id,"userId","planId","durationMonths","deviceLimit",currency,amount,"expiresAt","updatedAt")
        SELECT '20000000-0000-4000-8000-'||lpad(i::text,12,'0'),
          '10000000-0000-4000-8000-'||lpad(i::text,12,'0'), ${plan.id}, 1, 3, 'RUB',
          12000, now() + interval '30 minutes', now() FROM generate_series(1,${count}) AS s(i)`;
      await db.$executeRaw`
        INSERT INTO "Payment"(id,"orderId",provider,"externalId","merchantReference",amount,currency,"updatedAt")
        SELECT '30000000-0000-4000-8000-'||lpad(i::text,12,'0'),
          '20000000-0000-4000-8000-'||lpad(i::text,12,'0'), 'PLATEGA', 'fixture-external-'||i,
          'fixture-invoice-'||i, 12000, 'RUB', now() FROM generate_series(1,${count}) AS s(i)`;
      await db.$executeRaw`
        INSERT INTO "AuthIdentity"(id,"userId",provider,"providerId")
        SELECT '40000000-0000-4000-8000-'||lpad(i::text,12,'0'),
          '10000000-0000-4000-8000-'||lpad(i::text,12,'0'), 'TELEGRAM',
          (10000000+i)::text FROM generate_series(1,${count}) AS s(i)`;
      await db.$executeRaw`
        INSERT INTO "Subscription"(id,"userId")
        SELECT '50000000-0000-4000-8000-'||lpad(i::text,12,'0'),
          '10000000-0000-4000-8000-'||lpad(i::text,12,'0') FROM generate_series(1,${count}) AS s(i)`;
    }, { timeout: 40_000 });

    const lookups = {
      email: `bench-${index}@example.invalid`, displayName: `Bench client ${index}`,
      telegram: String(10_000_000 + index), order: id(2, index), subscription: id(5, index), payment: id(3, index),
      providerReference: `fixture-external-${index}`, merchantReference: `fixture-invoice-${index}`,
    };
    for (const [method, query] of Object.entries(lookups)) {
      const times: number[] = [];
      for (let sample = 0; sample < 25; sample++) {
        const start = performance.now();
        const response = await api.post("/api/users/search", { query });
        const elapsed = performance.now() - start;
        expect(response.statusCode).toBe(200);
        expect(response.json().items.map((row: { id: string }) => row.id)).toEqual([id(1, index)]);
        if (sample >= 5) times.push(elapsed);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      console.log(`Customer search ${method}: p95 ${p95.toFixed(1)} ms (20 samples)`);
      expect(p95, method).toBeLessThan(2_000);
    }
  } finally {
    await app.close();
    await resetDatabase(40_000);
  }
}, 100_000);
