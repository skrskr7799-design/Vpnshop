import { defineConfig } from "vitest/config";

// run.sh provisions the database and supplies a fresh marker for each run.
const url = new URL(process.env.TEST_DATABASE_URL ?? "");
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port ||
    url.username !== "vpnshop_suite" || url.pathname !== "/vpnshop_suite" ||
    url.search || url.hash || !/^[a-f0-9]{32}$/.test(process.env.VPNSHOP_TEST_MARKER ?? "")) {
  throw new Error("Integration tests require the disposable database created by test:integration");
}

export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    setupFiles: ["./src/test/check-database.ts"],
    fileParallelism: false, // файлы делят одну БД
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      ADMIN_ENABLED: "true",
      ADMIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      DATABASE_URL: url.href,
      WEB_ORIGIN: "http://localhost:5173",
      COOKIE_SECRET: "c".repeat(40),
      JWT_SECRET: "j".repeat(40),
      REMNAWAVE_URL: "https://panel.example.com",
      REMNAWAVE_TOKEN: "test-token",
      REMNAWAVE_INTERNAL_SQUAD_UUIDS: "11111111-1111-4111-8111-111111111111",
    },
  },
});
