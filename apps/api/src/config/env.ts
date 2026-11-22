import { panelSettings } from "./panel-env";
import { z } from "zod";

// Пустая строка в .env (VAR=) считается «не задано»
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    CHECKOUT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    WEB_TRUSTED_PROXIES: z.string().default("").transform(value => value.split(",").map(x => x.trim()).filter(Boolean)),
    TELEGRAM_OIDC_VERIFIED: z.enum(["true", "false"]).default("false"),
    WEB_ORIGIN: z.url(),
    COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET must be at least 32 characters"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    // smtp://user:pass@host:587 . В dev можно не задавать: письма пишутся в лог.
    SMTP_URL: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    MAIL_FROM: z.string().default("VPN Shop <no-reply@localhost>"),
    // Вход через Google и Telegram включается, только если задана пара id + secret
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    TELEGRAM_CLIENT_ID: optionalString,
    TELEGRAM_CLIENT_SECRET: optionalString,
    // ── Админка: отдельный сервер на своём порту, по умолчанию выключен ──
    ADMIN_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // По умолчанию слушаем только localhost: наружу админку выводит reverse proxy или VPN
    ADMIN_HOST: z.string().default("127.0.0.1"),
    ADMIN_PORT: z.coerce.number().int().positive().default(3001),
    // Origin фронта админки (проверка Origin, CORS)
    ADMIN_ORIGIN: z.url().default("http://localhost:5174"),
    ADMIN_TRUSTED_PROXIES: z.string().default("").transform(value => value.split(",").map(part => part.trim()).filter(Boolean)),
    // Разрешённые адреса/сети (CIDR) через запятую. Пусто = без ограничения по IP
    ADMIN_ALLOWED_CIDRS: z
      .string()
      .optional()
      .transform((v) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)),
    // 32 байта в base64: `openssl rand -base64 32`. Из него выводятся ключи шифрования TOTP и подписи.
    ADMIN_ENCRYPTION_KEY: optionalString,
    ADMIN_SESSION_HOURS: z.coerce.number().positive().default(12),
    ADMIN_IDLE_MINUTES: z.coerce.number().positive().default(30),
    ...panelSettings,
  })
  .refine((v) => v.NODE_ENV !== "production" || Boolean(v.SMTP_URL), {
    path: ["SMTP_URL"],
    message: "SMTP_URL is required in production",
  })
  .refine((v) => !v.ADMIN_ENABLED || Boolean(v.ADMIN_ENCRYPTION_KEY), {
    path: ["ADMIN_ENCRYPTION_KEY"],
    message: "ADMIN_ENCRYPTION_KEY is required when ADMIN_ENABLED=true",
  })
  .refine((v) => !v.ADMIN_ENCRYPTION_KEY || Buffer.from(v.ADMIN_ENCRYPTION_KEY, "base64").length === 32, {
    path: ["ADMIN_ENCRYPTION_KEY"],
    message: "ADMIN_ENCRYPTION_KEY must be 32 bytes in base64",
  })
  .refine((v) => Boolean(v.GOOGLE_CLIENT_ID) === Boolean(v.GOOGLE_CLIENT_SECRET), {
    path: ["GOOGLE_CLIENT_SECRET"],
    message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
  })
  .refine((v) => Boolean(v.TELEGRAM_CLIENT_ID) === Boolean(v.TELEGRAM_CLIENT_SECRET), {
    path: ["TELEGRAM_CLIENT_SECRET"],
    message: "TELEGRAM_CLIENT_ID and TELEGRAM_CLIENT_SECRET must be set together",
  });

// Fail-fast: приложение не стартует с неверным конфигом.
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
