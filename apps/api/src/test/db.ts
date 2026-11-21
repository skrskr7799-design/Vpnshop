import { prisma } from "../lib/prisma";

// Очистка БД между тестами. Защита: работает только с базой, в имени которой есть "test",
// чтобы случайно не стереть рабочие данные.
export async function resetDatabase(): Promise<void> {
  const name = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/").pathname;
  if (!/test/i.test(name)) {
    throw new Error(`Отказ: интеграционные тесты очищают БД, а в имени "${name}" нет "test"`);
  }
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}
