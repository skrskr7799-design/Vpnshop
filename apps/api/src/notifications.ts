import nodemailer from "nodemailer";
import { env } from "./config/env";
import { runPeriodic } from "./lib/periodic";
import { deliverNext } from "./modules/mail/outbox";

if (env.MZT_PROCESS !== "notifications" || !env.SMTP_URL || !env.MAIL_QUEUE_KEY) throw new Error("Invalid notification process configuration");
const url = new URL(env.SMTP_URL);
if (!["smtp:", "smtps:"].includes(url.protocol)) throw new Error("Invalid SMTP protocol");
const transport = nodemailer.createTransport({
  host: url.hostname, port: Number(url.port || (url.protocol === "smtps:" ? 465 : 587)),
  secure: url.protocol === "smtps:", requireTLS: true, connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 8000,
  auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
});
await runPeriodic("notifications", 3004, () => deliverNext(async (mail, id) => {
  await transport.sendMail({ from: env.MAIL_FROM, ...mail, messageId: `<${id}@vpnshop.local>` });
}));
