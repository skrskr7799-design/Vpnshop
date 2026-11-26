import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { sendMail } from "../mail/mail.service";
import { createEmailAccount, requestEmailVerification, setEmailPassword, forgotPassword, getCurrentUser, login, register, resetPassword, verifyEmail } from "./auth.service";
import { REFRESH_REUSE_GRACE_MS } from "./auth.constants";
import { verifyAccessToken } from "./jwt";
import { hashPassword } from "./password";
import { createSession, revokeSessionFamily, rotateSession } from "./session.service";

// Почта подменена: из письма достаём ссылку, как это сделал бы пользователь
vi.mock("../mail/mail.service", () => ({ sendMail: vi.fn(async () => {}) }));

const ctx = { log: { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger, ip: "203.0.113.5", userAgent: "vitest" };
const PASSWORD = "correct-horse-battery";
const mails = () => vi.mocked(sendMail).mock.calls.map(([, mail]) => mail);
const lastMail = () => mails().at(-1)!;
const tokenFrom = (mail: { text: string }) => new URLSearchParams(new URL(mail.text.match(/https?:\/\/\S+/)![0]).hash.slice(1)).get("token")!;

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(sendMail).mockClear();
});

async function registerAndVerify(email: string, password = PASSWORD) {
  await register({ email, password }, ctx);
  await verifyEmail(tokenFrom(lastMail()));
  return prisma.user.findUniqueOrThrow({ where: { email } });
}

describe("регистрация и подтверждение почты", () => {
  it("до подтверждения аккаунта нет, после ссылки он создаётся", async () => {
    await register({ email: "new@example.com", password: PASSWORD }, ctx);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.pendingRegistration.count()).toBe(1);
    expect(lastMail()).toMatchObject({ to: "new@example.com" });

    await verifyEmail(tokenFrom(lastMail()));

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "new@example.com" }, include: { identities: true } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.identities).toHaveLength(1);
    expect(user.identities[0]).toMatchObject({ provider: "EMAIL", providerId: "new@example.com" });
    expect(user.identities[0]!.verifiedAt).not.toBeNull();
    expect(user.identities[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await prisma.pendingRegistration.count()).toBe(0);
  });

  it("ссылка одноразовая", async () => {
    await register({ email: "once@example.com", password: PASSWORD }, ctx);
    const token = tokenFrom(lastMail());
    await verifyEmail(token);
    await expect(verifyEmail(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect(await prisma.user.count()).toBe(1);
  });

  it("просроченная ссылка не работает", async () => {
    await register({ email: "late@example.com", password: PASSWORD }, ctx);
    await prisma.pendingRegistration.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(verifyEmail(tokenFrom(lastMail()))).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect(await prisma.user.count()).toBe(0);
  });

  it("два параллельных клика по одной ссылке создают ровно один аккаунт", async () => {
    await register({ email: "race@example.com", password: PASSWORD }, ctx);
    const token = tokenFrom(lastMail());
    const results = await Promise.allSettled([verifyEmail(token), verifyEmail(token), verifyEmail(token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("повторная регистрация существующего email: заявка не создаётся, на почту уходит «аккаунт уже есть»", async () => {
    await registerAndVerify("taken@example.com");
    vi.mocked(sendMail).mockClear();
    await register({ email: "taken@example.com", password: "another-password-1" }, ctx);

    expect(await prisma.pendingRegistration.count()).toBe(0);
    expect(lastMail().subject).toContain("уже есть аккаунт");
    expect(lastMail().text).not.toContain("token=");
  });

  it("не больше 3 писем в час на один адрес", async () => {
    for (let i = 0; i < 5; i++) await register({ email: "spam@example.com", password: PASSWORD }, ctx);
    expect(await prisma.pendingRegistration.count()).toBe(3);
    expect(mails()).toHaveLength(3);
  });

  it("pre-hijacking: заранее занять чужой email нельзя, аккаунт получает пароль того, кто открыл ссылку", async () => {
    // Злоумышленник регистрирует чужой адрес со своим паролем
    await register({ email: "victim@example.com", password: "attacker-password-1" }, ctx);
    const attackerToken = tokenFrom(lastMail());
    // Владелец ящика регистрируется сам и подтверждает свою ссылку
    await register({ email: "victim@example.com", password: "victim-password-1" }, ctx);
    await verifyEmail(tokenFrom(lastMail()));

    // Вход возможен только с паролем владельца
    await expect(login({ email: "victim@example.com", password: "attacker-password-1" }, ctx)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(login({ email: "victim@example.com", password: "victim-password-1" }, ctx)).resolves.toBeTruthy();
    // а ссылка злоумышленника после этого бесполезна
    await expect(verifyEmail(attackerToken)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});

describe("вход", () => {
  it("успешный вход создаёт сессию и отдаёт токены", async () => {
    await registerAndVerify("login@example.com");
    const result = await login({ email: "login@example.com", password: PASSWORD }, ctx);
    expect(result.user.email).toBe("login@example.com");
    expect(result.accessToken.split(".")).toHaveLength(3);
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("неверный пароль и несуществующий аккаунт дают одинаковую ошибку", async () => {
    await registerAndVerify("known@example.com");
    const wrong = await login({ email: "known@example.com", password: "wrong-password-1" }, ctx).catch((e) => e);
    const unknown = await login({ email: "nobody@example.com", password: "wrong-password-1" }, ctx).catch((e) => e);
    expect(wrong).toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
    expect(unknown).toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
  });

  it("заблокированный пользователь войти не может", async () => {
    await registerAndVerify("blocked@example.com");
    await prisma.user.update({ where: { email: "blocked@example.com" }, data: { status: "BLOCKED" } });
    await expect(login({ email: "blocked@example.com", password: PASSWORD }, ctx)).rejects.toMatchObject({
      code: "ACCOUNT_BLOCKED",
    });
  });

  it("getCurrentUser: блокировка действует сразу", async () => {
    const user = await registerAndVerify("me@example.com");
    expect((await getCurrentUser(user.id)).email).toBe("me@example.com");
    await prisma.user.update({ where: { id: user.id }, data: { status: "BLOCKED" } });
    await expect(getCurrentUser(user.id)).rejects.toMatchObject({ code: "ACCOUNT_BLOCKED" });
  });
});

describe("сессии и ротация refresh-токена", () => {
  async function newSession() {
    const user = await createUser();
    const tokens = await createSession(user, { ip: "203.0.113.5" });
    return { user, tokens };
  }

  it("ротация выдаёт новый токен в той же «семье», старый гасится", async () => {
    const { tokens } = await newSession();
    const next = await rotateSession(tokens.refreshToken, {});
    expect(next.refreshToken).not.toBe(tokens.refreshToken);

    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.familyId)).size).toBe(1);
    expect(sessions.filter((s) => s.revokedAt === null)).toHaveLength(1);
  });

  it("повторное предъявление старого токена в окне гонки: REFRESH_RACE, семья цела", async () => {
    const { tokens } = await newSession();
    const next = await rotateSession(tokens.refreshToken, {});

    await expect(rotateSession(tokens.refreshToken, {})).rejects.toMatchObject({ code: "REFRESH_RACE" });
    await expect(rotateSession(next.refreshToken, {})).resolves.toBeTruthy(); // новый токен жив
  });

  it("повторное предъявление после окна гонки = кража: отзывается вся семья", async () => {
    const { tokens } = await newSession();
    const next = await rotateSession(tokens.refreshToken, {});
    const old = new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 5000);
    await prisma.session.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: old, revokedAt: old } });

    await expect(rotateSession(tokens.refreshToken, {})).rejects.toMatchObject({ code: "INVALID_SESSION" });
    // даже легитимный новый токен теперь недействителен
    await expect(rotateSession(next.refreshToken, {})).rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(0);
  });

  it("параллельное обновление одним токеном: успешно ровно одно", async () => {
    const { tokens } = await newSession();
    const results = await Promise.allSettled([
      rotateSession(tokens.refreshToken, {}),
      rotateSession(tokens.refreshToken, {}),
      rotateSession(tokens.refreshToken, {}),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("просроченная сессия не обновляется", async () => {
    const { tokens } = await newSession();
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(rotateSession(tokens.refreshToken, {})).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });

  it("заблокированного пользователя обновить нельзя", async () => {
    const { user, tokens } = await newSession();
    await prisma.user.update({ where: { id: user.id }, data: { status: "BLOCKED" } });
    await expect(rotateSession(tokens.refreshToken, {})).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });

  it("токен, отозванный выходом, отклоняется сразу (INVALID_SESSION), а не как «гонка вкладок»", async () => {
    const { tokens } = await newSession();
    await revokeSessionFamily(tokens.refreshToken);
    await expect(rotateSession(tokens.refreshToken, {})).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });

  it("выход гасит всю семью токенов устройства, но не других устройств", async () => {
    const { user, tokens } = await newSession();
    const other = await createSession(user, {});
    await rotateSession(tokens.refreshToken, {});

    await revokeSessionFamily(tokens.refreshToken);

    await expect(rotateSession(other.refreshToken, {})).resolves.toBeTruthy(); // другое устройство живо
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(1);
  });
});

describe("сброс пароля", () => {
  it("полный цикл: ссылка, новый пароль, старый не работает, все сессии отозваны", async () => {
    await registerAndVerify("reset@example.com");
    const session = await login({ email: "reset@example.com", password: PASSWORD }, ctx);
    vi.mocked(sendMail).mockClear();

    await forgotPassword({ email: "reset@example.com" }, ctx);
    await resetPassword({ token: tokenFrom(lastMail()), password: "brand-new-password-1" });

    await expect(login({ email: "reset@example.com", password: PASSWORD }, ctx)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(login({ email: "reset@example.com", password: "brand-new-password-1" }, ctx)).resolves.toBeTruthy();
    // старая сессия отозвана и отклоняется сразу, а не как «гонка вкладок»
    await expect(rotateSession(session.refreshToken, {})).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });

  it("ссылка одноразовая, новая ссылка гасит старую", async () => {
    await registerAndVerify("once@example.com");
    vi.mocked(sendMail).mockClear();
    await forgotPassword({ email: "once@example.com" }, ctx);
    const first = tokenFrom(lastMail());
    await forgotPassword({ email: "once@example.com" }, ctx);
    const second = tokenFrom(lastMail());

    await expect(resetPassword({ token: first, password: "new-password-12345" })).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await resetPassword({ token: second, password: "new-password-12345" });
    await expect(resetPassword({ token: second, password: "new-password-67890" })).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("несуществующий email: письма нет, ответ тот же (нет утечки)", async () => {
    await forgotPassword({ email: "ghost@example.com" }, ctx);
    expect(mails()).toHaveLength(0);
  });

  it("пользователь без пароля (пришёл через Google) может его задать", async () => {
    const user = await prisma.user.create({
      data: { email: "g@example.com", emailVerifiedAt: new Date(), identities: { create: { provider: "GOOGLE", providerId: "g-sub", verifiedAt: new Date() } } },
    });
    await forgotPassword({ email: "g@example.com" }, ctx);
    await resetPassword({ token: tokenFrom(lastMail()), password: "my-new-password-1" });

    expect(await prisma.authIdentity.count({ where: { userId: user.id } })).toBe(2);
    await expect(login({ email: "g@example.com", password: "my-new-password-1" }, ctx)).resolves.toBeTruthy();
  });

  it("не больше 3 писем в час", async () => {
    await registerAndVerify("flood@example.com");
    vi.mocked(sendMail).mockClear();
    for (let i = 0; i < 6; i++) await forgotPassword({ email: "flood@example.com" }, ctx);
    expect(mails()).toHaveLength(3);
  });

  it("истёкшая ссылка не работает", async () => {
    await registerAndVerify("exp@example.com");
    vi.mocked(sendMail).mockClear();
    await forgotPassword({ email: "exp@example.com" }, ctx);
    await prisma.verificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(resetPassword({ token: tokenFrom(lastMail()), password: "new-password-12345" })).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});

void hashPassword;

it("serializes confirmation of separate registrations for the same address", async () => {
  const email = "race@example.com";
  await Promise.all([register({ email, password: PASSWORD }, ctx), register({ email, password: PASSWORD + "-different" }, ctx)]);
  const results = await Promise.allSettled(mails().map(mail => verifyEmail(tokenFrom(mail))));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "INVALID_TOKEN" } });
  expect(await prisma.user.count({ where: { email } })).toBe(1);
});

it("can verify a manually activated account without resetting its credentials or removing a block", async () => {
  const email = "manual@example.com";
  const passwordHash = await hashPassword(PASSWORD);
  const { id } = await prisma.$transaction(db => createEmailAccount(db, { email, passwordHash, manualActivatedAt: new Date() }));
  await expect(login({ email, password: PASSWORD }, ctx)).resolves.toMatchObject({ user: { id, emailVerified: false } });
  await forgotPassword({ email }, ctx);
  expect(mails()).toHaveLength(0);
  await requestEmailVerification(email, ctx);
  const token = tokenFrom(lastMail());
  await prisma.user.update({ where: { id }, data: { status: "BLOCKED" } });
  await expect(verifyEmail(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  expect(await prisma.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "BLOCKED", emailVerifiedAt: null });
  await prisma.user.update({ where: { id }, data: { status: "ACTIVE" } });
  await verifyEmail(token);
  await expect(verifyEmail(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  expect(await prisma.authIdentity.findUniqueOrThrow({ where: { userId_provider: { userId: id, provider: "EMAIL" } } })).toMatchObject({ passwordHash });
  await expect(login({ email, password: PASSWORD }, ctx)).resolves.toMatchObject({ user: { id, emailVerified: true } });
});

it("adds a real email to a provider account only in the initiating session and revokes sessions when installing a password", async () => {
  const user = await prisma.user.create({ data: { identities: { create: { provider: "TELEGRAM", providerId: "34567", verifiedAt: new Date() } } } });
  const initiating = await createSession(user, {});
  const claims = (await verifyAccessToken(initiating.accessToken))!;
  const other = (await verifyAccessToken((await createSession(user, {})).accessToken))!;
  const email = "verified-provider@example.com";
  const issue = (purpose: string) => prisma.identityProof.create({
    data: { familyId: claims.sid, target: "EMAIL", purpose, expiresAt: new Date(Date.now() + 600_000) },
  });
  const proof = await issue("VERIFY_EMAIL");
  await requestEmailVerification(email, ctx, { claims, id: proof.id });
  const token = tokenFrom(lastMail());
  await expect(verifyEmail(token, other)).rejects.toMatchObject({ code: "VERIFICATION_SESSION_REQUIRED" });
  await verifyEmail(token, claims);
  await expect(setEmailPassword(claims, proof.id, PASSWORD)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  await setEmailPassword(claims, (await issue("SET_PASSWORD")).id, PASSWORD);
  expect(await prisma.sessionFamily.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  await expect(login({ email, password: PASSWORD }, ctx)).resolves.toMatchObject({ user: { id: user.id, emailVerified: true } });
});
