import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { stageTokenKey } from "./admin.keys";
import { buildTestAdminApp, createEnrolledAdmin, ctx, PASSWORD } from "./admin.test-helpers";
import {
  adminLogin,
  confirmEnrollment,
  createAdminUser,
  LOCK_MS,
  MAX_FAILED_ATTEMPTS,
  resetAdminTotp,
  startEnrollment,
  verifySecondFactor,
} from "./auth/admin-auth.service";
import { createAdminSession, resolveAdminSession, revokeAdminSession } from "./auth/admin-session.service";
import { currentCode, generateTotpSecret } from "./auth/totp";

beforeEach(resetDatabase);

const STEP = 30_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
const stage = async (email: string) => (await adminLogin({ email, password: PASSWORD }, ctx)).stageToken;
const auditActions = async () => (await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((a) => a.action);

describe("шаг 1: пароль", () => {
  it("админ без 2FA получает этап подключения, с 2FA получает этап проверки кода", async () => {
    await createAdminUser({ email: "a@example.com", password: PASSWORD, role: "ADMIN" });
    expect((await adminLogin({ email: "a@example.com", password: PASSWORD }, ctx)).step).toBe("enroll_2fa");

    const admin = await createEnrolledAdmin("b@example.com");
    expect((await adminLogin({ email: admin.email, password: PASSWORD }, ctx)).step).toBe("verify_2fa");
  });

  it("все причины отказа дают одну и ту же ошибку и пишутся в журнал", async () => {
    await createAdminUser({ email: "ok@example.com", password: PASSWORD, role: "ADMIN" });
    const blocked = await createAdminUser({ email: "blocked@example.com", password: PASSWORD, role: "ADMIN" });
    await prisma.user.update({ where: { id: blocked.userId }, data: { status: "BLOCKED" } });
    // обычный пользователь с паролем (не админ)
    const plain = await createUser({ email: "plain@example.com" });
    await prisma.authIdentity.create({
      data: { userId: plain.id, provider: "EMAIL", providerId: "plain@example.com", passwordHash: (await prisma.staffCredential.findFirstOrThrow()).passwordHash, verifiedAt: new Date() },
    });

    const attempts = [
      { email: "ok@example.com", password: "wrong-password-1" },
      { email: "nobody@example.com", password: PASSWORD },
      { email: "blocked@example.com", password: PASSWORD },
      { email: "plain@example.com", password: PASSWORD },
    ];
    for (const a of attempts) {
      await expect(adminLogin(a, ctx)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
    }
    expect((await auditActions()).filter((a) => a === "admin.login.failed")).toHaveLength(4);
  });

  it("пароль админа не короче 12 символов", async () => {
    await expect(createAdminUser({ email: "weak@example.com", password: "short", role: "ADMIN" })).rejects.toThrow("12");
  });

  it("rejects a bootstrap email already used by a customer", async () => {
    const user = await createUser({ email: "promote@example.com" });
    await expect(createAdminUser({ email: "promote@example.com", password: PASSWORD, role: "SUPPORT" }))
      .rejects.toMatchObject({ code: "STAFF_ADDRESS_IN_USE" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe("USER");
  });
});

describe("подключение 2FA", () => {
  it("секрет хранится зашифрованным, подтверждение даёт сессию и 10 резервных кодов", async () => {
    await createAdminUser({ email: "e@example.com", password: PASSWORD, role: "ADMIN" });
    const token = await stage("e@example.com");
    const { secret, otpauthUri } = await startEnrollment(token);
    expect(otpauthUri).toContain("otpauth://totp/");

    const stored = await prisma.adminTotp.findFirstOrThrow();
    expect(stored.secretEnc).not.toContain(secret); // в БД нет открытого секрета
    expect(stored.confirmedAt).toBeNull();

    const result = await confirmEnrollment(token, currentCode(secret), ctx);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(await resolveAdminSession(result.sessionToken)).toMatchObject({ role: "ADMIN" });
    expect((await prisma.adminTotp.findFirstOrThrow()).confirmedAt).not.toBeNull();
    // в БД только хэши резервных кодов
    const hashes = (await prisma.adminRecoveryCode.findMany()).map((r) => r.codeHash);
    expect(hashes).toHaveLength(10);
    for (const code of result.recoveryCodes) expect(hashes).not.toContain(code);
  });

  it("неверный код не подключает 2FA и не даёт сессию", async () => {
    await createAdminUser({ email: "w@example.com", password: PASSWORD, role: "ADMIN" });
    const token = await stage("w@example.com");
    await startEnrollment(token);
    await expect(confirmEnrollment(token, currentCode(generateTotpSecret()), ctx)).rejects.toMatchObject({ code: "INVALID_CODE" });
    expect(await prisma.adminSession.count()).toBe(0);
  });

  it("повторное подключение при уже включённой 2FA запрещено", async () => {
    const admin = await createEnrolledAdmin("again@example.com");
    // злоумышленник с паролем получает этап «проверка», а не «подключение»: токен подключения ему не выдаётся
    const verifyStage = await stage(admin.email);
    await expect(startEnrollment(verifyStage)).rejects.toMatchObject({ code: "INVALID_STAGE" });
  });

  it("retries the same enrollment and issues one recovery-code set across concurrent confirmations", async () => {
    await createAdminUser({ email: "restart@example.com", password: PASSWORD, role: "ADMIN" });
    const token = await stage("restart@example.com");
    const first = await startEnrollment(token);
    expect(await startEnrollment(token)).toEqual(first);
    const results = await Promise.allSettled([1, 2].map(() => confirmEnrollment(token, currentCode(first.secret), ctx)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.adminRecoveryCode.count()).toBe(10);
    expect(await prisma.adminSession.count()).toBe(1);
  });
});

describe("шаг 2: код", () => {
  it("верный код даёт сессию", async () => {
    const admin = await createEnrolledAdmin("v@example.com");
    const when = at(5 * STEP); // позже шага, использованного при подключении
    const result = await verifySecondFactor(await stage(admin.email), { code: currentCode(admin.secret, when.getTime()) }, ctx, when);
    expect(await resolveAdminSession(result.sessionToken)).toMatchObject({ email: "v@example.com" });
  });

  it("один и тот же код нельзя использовать дважды (повтор)", async () => {
    const admin = await createEnrolledAdmin("replay@example.com");
    const when = at(5 * STEP);
    const code = currentCode(admin.secret, when.getTime());
    await verifySecondFactor(await stage(admin.email), { code }, ctx, when);
    await expect(verifySecondFactor(await stage(admin.email), { code }, ctx, when)).rejects.toMatchObject({ code: "INVALID_CODE" });
  });

  it("код, использованный при подключении, повторно не принимается", async () => {
    const admin = await createEnrolledAdmin("enrollreplay@example.com");
    await expect(
      verifySecondFactor(await stage(admin.email), { code: currentCode(admin.secret) }, ctx),
    ).rejects.toMatchObject({ code: "INVALID_CODE" });
  });

  it("параллельные запросы с одним кодом: проходит ровно один", async () => {
    const admin = await createEnrolledAdmin("race@example.com");
    const when = at(5 * STEP);
    const code = currentCode(admin.secret, when.getTime());
    const token = await stage(admin.email);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => verifySecondFactor(token, { code }, ctx, when)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.adminSession.count({ where: { revokedAt: null } })).toBe(2); // подключение + этот вход
  });

  it(`после ${MAX_FAILED_ATTEMPTS} неверных кодов ввод блокируется, даже верный код не проходит; потом блокировка снимается`, async () => {
    const admin = await createEnrolledAdmin("lock@example.com");
    const when = at(5 * STEP);
    const wrong = currentCode(generateTotpSecret(), when.getTime());
    const token = await stage(admin.email);

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await expect(verifySecondFactor(token, { code: wrong }, ctx, when)).rejects.toMatchObject({ code: "INVALID_CODE" });
    }
    const good = currentCode(admin.secret, when.getTime());
    await expect(verifySecondFactor(token, { code: good }, ctx, when)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED", statusCode: 429 });

    const later = new Date(when.getTime() + LOCK_MS + 2 * STEP);
    await expect(verifySecondFactor(token, { code: currentCode(admin.secret, later.getTime()) }, ctx, later)).resolves.toBeTruthy();
  });

  it("успешный вход обнуляет счётчик неудач", async () => {
    const admin = await createEnrolledAdmin("reset@example.com");
    const when = at(5 * STEP);
    const token = await stage(admin.email);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      await verifySecondFactor(token, { code: currentCode(generateTotpSecret(), when.getTime()) }, ctx, when).catch(() => {});
    }
    await verifySecondFactor(token, { code: currentCode(admin.secret, when.getTime()) }, ctx, when);
    expect((await prisma.adminTotp.findFirstOrThrow()).failedAttempts).toBe(0);
  });

  it("резервный код работает один раз, при параллельном использовании побеждает один запрос", async () => {
    const admin = await createEnrolledAdmin("rec@example.com");
    const [first, second] = admin.recoveryCodes as [string, string];

    const results = await Promise.allSettled([
      verifySecondFactor(await stage(admin.email), { recoveryCode: first }, ctx),
      verifySecondFactor(await stage(admin.email), { recoveryCode: first.toLowerCase().replace("-", " ") }, ctx),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    await expect(verifySecondFactor(await stage(admin.email), { recoveryCode: first }, ctx)).rejects.toMatchObject({ code: "INVALID_CODE" });
    const ok = await verifySecondFactor(await stage(admin.email), { recoveryCode: second }, ctx);
    expect(ok.recoveryCodesLeft).toBe(8);
    expect(await auditActions()).toContain("admin.login.recovery_code");
  });

  it("токен этапа: чужой этап, просроченный и подделанный отклоняются", async () => {
    const admin = await createEnrolledAdmin("stage@example.com");
    // exp числом это абсолютный момент (секунды), строкой вроде "1h" это «через час от сейчас»
    const sign = (exp: string | number, stageName = "verify", key = stageTokenKey()) =>
      new SignJWT({ stage: stageName })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(admin.userId)
        .setIssuer("vpn-shop")
        .setAudience("vpn-shop:admin-stage")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(exp)
        .sign(key);
    const when = at(5 * STEP);
    const code = currentCode(admin.secret, when.getTime());

    const expired = Math.floor(Date.now() / 1000) - 3600;
    await expect(verifySecondFactor(await sign(expired), { code }, ctx, when)).rejects.toMatchObject({ code: "INVALID_STAGE" }); // истёк
    await expect(verifySecondFactor(await sign("1h", "enroll"), { code }, ctx, when)).rejects.toMatchObject({ code: "INVALID_STAGE" }); // не тот этап
    await expect(verifySecondFactor(await sign("1h", "verify", Buffer.alloc(32, 1)), { code }, ctx, when)).rejects.toMatchObject({ code: "INVALID_STAGE" }); // чужой ключ
    await expect(verifySecondFactor("garbage", { code }, ctx, when)).rejects.toMatchObject({ code: "INVALID_STAGE" });
  });
});

describe("сессии", () => {
  it("истекает при бездействии, но активность продлевает её; абсолютный предел не продлевается", async () => {
    const admin = await createEnrolledAdmin("sess@example.com");
    const t0 = new Date();
    const { token } = await createAdminSession(admin.userId, ctx, t0);
    const min = (n: number) => new Date(t0.getTime() + n * 60_000);

    expect(await resolveAdminSession(token, min(29))).not.toBeNull(); // продлевает окно до 59-й минуты
    expect(await resolveAdminSession(token, min(58))).not.toBeNull(); // продлевает до 88-й
    expect(await resolveAdminSession(token, min(120))).toBeNull(); // бездействие больше 30 минут

    const fresh = await createAdminSession(admin.userId, ctx, t0);
    // активность каждые 20 минут не удерживает сессию дольше абсолютного предела (12 ч)
    for (let m = 20; m <= env.ADMIN_SESSION_HOURS * 60 - 10; m += 20) {
      expect(await resolveAdminSession(fresh.token, min(m))).not.toBeNull();
    }
    expect(await resolveAdminSession(fresh.token, min(env.ADMIN_SESSION_HOURS * 60 + 1))).toBeNull();
  });

  it("отзыв, блокировка и потеря роли действуют мгновенно", async () => {
    const admin = await createEnrolledAdmin("instant@example.com");
    const { token } = await createAdminSession(admin.userId, ctx);
    expect(await resolveAdminSession(token)).not.toBeNull();

    await prisma.user.update({ where: { id: admin.userId }, data: { status: "BLOCKED" } });
    expect(await resolveAdminSession(token)).toBeNull();
    await prisma.user.update({ where: { id: admin.userId }, data: { status: "ACTIVE", role: "USER" } });
    expect(await resolveAdminSession(token)).toBeNull();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
    expect(await resolveAdminSession(token)).not.toBeNull();

    await revokeAdminSession(token);
    expect(await resolveAdminSession(token)).toBeNull();
  });

  it("сброс 2FA из CLI закрывает все сессии и требует подключить 2FA заново", async () => {
    const admin = await createEnrolledAdmin("cli@example.com");
    expect(await resolveAdminSession(admin.sessionToken)).not.toBeNull();

    expect(await resetAdminTotp("cli@example.com")).toBe(true);
    expect(await resolveAdminSession(admin.sessionToken)).toBeNull();
    expect((await adminLogin({ email: "cli@example.com", password: PASSWORD }, ctx)).step).toBe("enroll_2fa");
    expect(await resetAdminTotp("ghost@example.com")).toBe(false);
  });
});

describe("HTTP: вход", () => {
  it("полный цикл: пароль, подключение 2FA, кука, /me, выход", async () => {
    const app = await buildTestAdminApp();
    await createAdminUser({ email: "http@example.com", password: PASSWORD, role: "ADMIN" });
    const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { origin: env.ADMIN_ORIGIN } });

    const login = (await post("/api/auth/login", { email: "http@example.com", password: PASSWORD })).json();
    expect(login.step).toBe("enroll_2fa");
    const start = (await post("/api/auth/2fa/enroll/start", { stageToken: login.stageToken })).json();
    const confirm = await post("/api/auth/2fa/enroll/confirm", { stageToken: login.stageToken, code: currentCode(start.secret) });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(10);

    const cookie = confirm.cookies.find((c) => c.name === "vpn_admin")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });

    const me = await app.inject({ method: "GET", url: "/api/me", cookies: { vpn_admin: cookie.value } });
    expect(me.json()).toMatchObject({ user: { email: "http@example.com", role: "ADMIN" } });
    expect(me.json().permissions).toContain("plans:write");
    expect(me.headers["cache-control"]).toBe("no-store");

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { vpn_admin: cookie.value }, headers: { origin: env.ADMIN_ORIGIN } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: { vpn_admin: cookie.value } })).statusCode).toBe(401);
    await app.close();
  });

  it("повторный вход с резервным кодом через HTTP", async () => {
    const app = await buildTestAdminApp();
    const admin = await createEnrolledAdmin("httprec@example.com");
    const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { origin: env.ADMIN_ORIGIN } });
    const login = (await post("/api/auth/login", { email: admin.email, password: PASSWORD })).json();
    expect(login.step).toBe("verify_2fa");

    const bad = await post("/api/auth/2fa/verify", { stageToken: login.stageToken, recoveryCode: "AAAAA-AAAAA" });
    expect(bad.statusCode).toBe(401);
    const ok = await post("/api/auth/2fa/verify", { stageToken: login.stageToken, recoveryCode: admin.recoveryCodes[0] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodesLeft).toBe(9);
    expect(ok.cookies.find((c) => c.name === "vpn_admin")).toBeTruthy();
    await app.close();
  });

  it("запрос должен содержать либо код, либо резервный код", async () => {
    const app = await buildTestAdminApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/2fa/verify", headers: { origin: env.ADMIN_ORIGIN }, payload: { stageToken: "x".repeat(30) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });
});
