import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Тесты с настоящей БД запускаются отдельно: pnpm test:integration
    exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
    // Фиктивный конфиг: модули читают env при импорте
    env: {
      NODE_ENV: "test",
      ADMIN_ENABLED: "true",
      ADMIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      WEB_ORIGIN: "http://localhost:5173",
      COOKIE_SECRET: "c".repeat(40),
      JWT_SECRET: "j".repeat(40),
      REMNAWAVE_URL: "https://panel.example.com",
      REMNAWAVE_TOKEN: "test-token",
      REMNAWAVE_INTERNAL_SQUAD_UUIDS: "11111111-1111-4111-8111-111111111111",
    },
  },
});
