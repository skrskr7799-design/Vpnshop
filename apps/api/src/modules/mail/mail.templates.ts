import { env } from "../../config/env";
import type { Mail } from "./mail.service";

function link(path: string, token?: string): string {
  const url = new URL(path, env.WEB_ORIGIN);
  if (token) url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export const verifyEmailMail = (to: string, token: string): Mail => ({
  to,
  subject: "Подтвердите регистрацию · " + env.BRAND_NAME,
  text: [
    "Чтобы завершить регистрацию, перейдите по ссылке (действует 24 часа):",
    link("/verify-email", token),
    "",
    "Если вы не регистрировались, просто проигнорируйте это письмо.",
  ].join("\n"),
});

export const accountExistsMail = (to: string): Mail => ({
  to,
  subject: "У вас уже есть аккаунт · " + env.BRAND_NAME,
  text: [
    "Кто-то пытался зарегистрироваться с этим адресом, но аккаунт уже существует.",
    `Войти: ${link("/login")}`,
    `Забыли пароль: ${link("/forgot-password")}`,
    "",
    "Если это были не вы, ничего делать не нужно.",
  ].join("\n"),
});

export const resetPasswordMail = (to: string, token: string): Mail => ({
  to,
  subject: "Сброс пароля · " + env.BRAND_NAME,
  text: [
    "Чтобы задать новый пароль, перейдите по ссылке (действует 1 час):",
    link("/reset-password", token),
    "",
    "Если вы не запрашивали сброс, проигнорируйте письмо: пароль не изменится.",
  ].join("\n"),
});

export const supportUpdateMail = (to: string, id: string): Mail => ({
  to,
  subject: "Обновление обращения · " + env.BRAND_NAME,
  text: ["В вашем обращении есть обновление. Войдите в личный кабинет, чтобы его посмотреть.", link("/account/support/" + id)].join("\n"),
});
