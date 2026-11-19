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
    REMNAWAVE_URL: z.url(),
    REMNAWAVE_TOKEN: z.string().min(1),
  })
  .refine((v) => v.NODE_ENV !== "production" || Boolean(v.SMTP_URL), {
    path: ["SMTP_URL"],
    message: "SMTP_URL is required in production",
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
