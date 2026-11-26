import { readSecret } from "./secrets";
import { exactHttpsOrigin, explicitPublicAdminAccess, isRestrictedPeer } from "./proxy";
import { productSettings } from "./product";
import { z } from "zod";

// Пустая строка в .env (VAR=) считается «не задано»
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z
  .object({
    ...productSettings,
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    MZT_PROCESS: z.enum(["public", "admin", "worker", "billing", "notifications", "exporter"]).default("public"),
    CHECKOUT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    WEB_TRUSTED_PROXIES: z.string().default("").transform(value => value.split(",").map(x => x.trim()).filter(Boolean)),
    MAIL_TRANSPORT_ENABLED: z.enum(["true", "false"]).optional(),
    GOOGLE_AUTH_ENABLED: z.enum(["true", "false"]).optional(),
    TELEGRAM_AUTH_ENABLED: z.enum(["true", "false"]).optional(),
    TELEGRAM_OIDC_VERIFIED: z.enum(["true", "false"]).default("false"),
    WEB_ORIGIN: z.url().default("http://localhost:5173"),
    COOKIE_SECRET: optionalString.pipe(z.string().min(32).optional()),
    JWT_SECRET: optionalString.pipe(z.string().min(32).optional()),
    // Production application processes only receive the mail capability, the consumer owns SMTP.
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
    ADMIN_2FA_POLICY: z.enum(["required", "optional", "disabled"]).default("required"),
    ADMIN_ACCESS_MODE: z.enum(["private", "public", "local"]).default("private"),
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
    MAIL_QUEUE_KEY: optionalString,
  })
  .refine(v => v.MZT_PROCESS !== "public" || !!v.COOKIE_SECRET && !!v.JWT_SECRET, { path: ["JWT_SECRET"], message: "Public session keys are required" })
  .refine(v => v.NODE_ENV !== "production" || v.MZT_PROCESS !== "public" || exactHttpsOrigin(v.WEB_ORIGIN) && !!v.MAIL_QUEUE_KEY,
    { path: ["WEB_ORIGIN"], message: "Public production requires HTTPS and mail queue encryption" })
  .refine(v => v.NODE_ENV !== "production" || v.MZT_PROCESS !== "notifications" || !!v.SMTP_URL && !!v.MAIL_QUEUE_KEY,
    { path: ["SMTP_URL"], message: "Notification transport and mail queue encryption are required" })
  .refine(v => !v.MAIL_QUEUE_KEY || Buffer.from(v.MAIL_QUEUE_KEY, "base64").length === 32,
    { path: ["MAIL_QUEUE_KEY"], message: "Mail queue key must be 32 bytes in base64" })
  .refine(v => v.MZT_PROCESS !== "admin" || !!v.ADMIN_ENCRYPTION_KEY,
    { path: ["ADMIN_ENCRYPTION_KEY"], message: "Admin role requires its encryption key" })
  .refine(v => [...v.WEB_TRUSTED_PROXIES, ...v.ADMIN_TRUSTED_PROXIES].every(isRestrictedPeer),
    { path: ["WEB_TRUSTED_PROXIES"], message: "Invalid or unrestricted network selector" })
  .refine(v => v.ADMIN_ALLOWED_CIDRS.every(isRestrictedPeer) ||
    explicitPublicAdminAccess(v.ADMIN_ACCESS_MODE, v.ADMIN_ALLOWED_CIDRS),
    { path: ["ADMIN_ALLOWED_CIDRS"], message: "Invalid administrative network policy" })
  .refine((v) => !v.ADMIN_ENCRYPTION_KEY || Buffer.from(v.ADMIN_ENCRYPTION_KEY, "base64").length === 32, {
    path: ["ADMIN_ENCRYPTION_KEY"],
    message: "ADMIN_ENCRYPTION_KEY must be 32 bytes in base64",
  })
  .refine(v => v.GOOGLE_AUTH_ENABLED !== "true" || !!v.GOOGLE_CLIENT_ID && !!v.GOOGLE_CLIENT_SECRET,
    { path: ["GOOGLE_AUTH_ENABLED"], message: "Enabled Google sign-in requires client credentials" })
  .refine(v => v.TELEGRAM_AUTH_ENABLED !== "true" || !!v.TELEGRAM_CLIENT_ID && !!v.TELEGRAM_CLIENT_SECRET && v.TELEGRAM_OIDC_VERIFIED === "true",
    { path: ["TELEGRAM_AUTH_ENABLED"], message: "Enabled Telegram sign-in requires verified OIDC and client credentials" })
  .refine(v => v.NODE_ENV !== "production" || v.MAIL_TRANSPORT_ENABLED !== "true" || !!v.MAIL_QUEUE_KEY,
    { path: ["MAIL_QUEUE_KEY"], message: "Enabled application mail requires queue encryption" })
  .refine((v) => Boolean(v.GOOGLE_CLIENT_ID) === Boolean(v.GOOGLE_CLIENT_SECRET), {
    path: ["GOOGLE_CLIENT_SECRET"],
    message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
  })
  .refine((v) => Boolean(v.TELEGRAM_CLIENT_ID) === Boolean(v.TELEGRAM_CLIENT_SECRET), {
    path: ["TELEGRAM_CLIENT_SECRET"],
    message: "TELEGRAM_CLIENT_ID and TELEGRAM_CLIENT_SECRET must be set together",
  });

// Fail-fast: приложение не стартует с неверным конфигом.
const input = { ...process.env };
for (const [key, value] of Object.entries(input)) {
  if (value === "" && Object.hasOwn(productSettings, key)) delete input[key];
}
for (const name of ["DATABASE_URL", "JWT_SECRET", "COOKIE_SECRET", "ADMIN_ENCRYPTION_KEY", "SMTP_URL",
  "MAIL_QUEUE_KEY", "GOOGLE_CLIENT_SECRET", "TELEGRAM_CLIENT_SECRET"]) input[name] = readSecret(name);
const parsed = schema.safeParse(input);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.issues.map(issue => issue.path.join(".")).join(", "));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const emailAvailable = env.MAIL_TRANSPORT_ENABLED !== undefined
  ? env.MAIL_TRANSPORT_ENABLED === "true"
  : !!env.SMTP_URL;
