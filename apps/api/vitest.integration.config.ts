import { defineConfig } from "vitest/config";

// Тесты с настоящим Postgres. Нужна отдельная БД с "test" в имени:
//   TEST_DATABASE_URL=postgresql://vpnshop:vpnshop@localhost:5432/vpnshop_test
//   pnpm --filter @vpn/api db:test:push && pnpm --filter @vpn/api test:integration
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    fileParallelism: false, // файлы делят одну БД
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      ADMIN_ENABLED: "true",
      ADMIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      WEB_ORIGIN: "http://localhost:5173",
      COOKIE_SECRET: "c".repeat(40),
      JWT_SECRET: "j".repeat(40),
      REMNAWAVE_URL: "https://panel.example.com",
      REMNAWAVE_TOKEN: "test-token",
      REMNAWAVE_INTERNAL_SQUAD_UUIDS: "11111111-1111-4111-8111-111111111111",
    },
  },
});
