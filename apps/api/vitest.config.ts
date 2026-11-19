import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Фиктивный конфиг: модули читают env при импорте
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      WEB_ORIGIN: "http://localhost:5173",
      COOKIE_SECRET: "c".repeat(40),
      JWT_SECRET: "j".repeat(40),
      REMNAWAVE_URL: "https://panel.example.com",
      REMNAWAVE_TOKEN: "test-token",
    },
  },
});
