import { expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { resetDatabase } from "./db";

it("requires the provisioned marker before deleting any rows", async () => {
  const row = await prisma.auditLog.create({ data: { action: "guard-test", entity: "fixture" } });
  const original = process.env.VPNSHOP_TEST_MARKER!;
  try {
    process.env.VPNSHOP_TEST_MARKER = original === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
    await expect(resetDatabase()).rejects.toThrow("Wrong database");
    expect(await prisma.auditLog.count({ where: { id: row.id } })).toBe(1);
  } finally {
    process.env.VPNSHOP_TEST_MARKER = original;
  }
});

it("runtime role cannot change the catalog, marker or migration history", async () => {
  const [row] = await prisma.$queryRaw<{ restricted: boolean }[]>`
    SELECT NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT has_table_privilege(current_user, 'test_guard.instance', 'UPDATE')
      AND NOT has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE')
      AND NOT has_table_privilege(current_user, 'public."Order"', 'TRUNCATE')
      AND NOT has_database_privilege(current_user, 'vpnshop_legacy', 'CONNECT') AS restricted`;
  expect(row?.restricted).toBe(true);
});
