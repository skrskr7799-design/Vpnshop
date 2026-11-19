import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";
import { env } from "../../config/env";

export type Mail = { to: string; subject: string; text: string };

const transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;

// Никогда не бросает: вызывающий код не должен ни падать, ни ждать SMTP
// (иначе по времени ответа можно отличить существующий email от несуществующего).
export async function sendMail(log: FastifyBaseLogger, mail: Mail): Promise<void> {
  if (!transport) {
    log.info({ to: mail.to, subject: mail.subject, text: mail.text }, "mail (SMTP не настроен, только dev)");
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, ...mail });
  } catch (err) {
    log.error({ err, to: mail.to }, "не удалось отправить письмо");
  }
}
