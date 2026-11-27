import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { linkProfile, listLinkedProviders, loginWithProfile } from "./oauth.service";
import { createSession } from "../auth/session.service";
import { verifyAccessToken } from "../auth/jwt";
import { setEmailPassword } from "../auth/auth.service";
import { createGoogleProvider } from "./providers/google";
import type { ProviderProfile } from "./oauth.types";

const google = (sub: string, email: string | null, emailVerified = true): ProviderProfile => ({
  providerId: sub,
  email,
  emailVerified,
});
const telegram = (id: string): ProviderProfile => ({ providerId: id, email: null, emailVerified: false });
const googleProvider = createGoogleProvider({ clientId: "fixture-client", clientSecret: "fixture-value" });

beforeEach(resetDatabase);
const family = async (id: string) => (await verifyAccessToken((await createSession({ id }, {})).accessToken))!;
const linkFor = async (id: string, provider: "GOOGLE" | "TELEGRAM", profile: ProviderProfile) =>
  linkProfile(await family(id), provider, profile);

describe("вход через внешний сервис", () => {
  it("Telegram: первый вход создаёт пользователя без email, повторный возвращает того же", async () => {
    const first = await loginWithProfile("TELEGRAM", telegram("987654321"));
    expect(first.email).toBeNull();
    const again = await loginWithProfile("TELEGRAM", telegram("987654321"));
    expect(again.id).toBe(first.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it("Google с подтверждённой почтой: создаёт пользователя с подтверждённым email", async () => {
    const user = await loginWithProfile("GOOGLE", google("g-1", "new@gmail.com"));
    expect(user).toMatchObject({ email: "new@gmail.com" });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await listLinkedProviders(user.id)).toEqual(["GOOGLE"]);
  });

  it("Google с email существующего пользователя требует явной привязки", async () => {
    const existing = await createUser({ email: "same@example.com" });
    await prisma.authIdentity.create({
      data: { userId: existing.id, provider: "EMAIL", providerId: "same@example.com", passwordHash: "x", verifiedAt: new Date() },
    });

    await expect(loginWithProfile("GOOGLE", google("g-2", "same@example.com"))).rejects.toMatchObject({ code: "EXPLICIT_LINK_REQUIRED" });
    expect(await prisma.user.count()).toBe(1);
    expect(await listLinkedProviders(existing.id)).toEqual(["EMAIL"]);
  });

  it("Google с неподтверждённой почтой активирует identity по sub без записи адреса", async () => {
    const first = await loginWithProfile("GOOGLE", google("g-3", "x@gmail.com", false));
    expect(first).toMatchObject({ email: null, emailVerifiedAt: null, activationRequired: false });
    expect((await loginWithProfile("GOOGLE", google("g-3", null, false))).id).toBe(first.id);
    const session = await family(first.id);
    await expect(setEmailPassword(session, session.sid, "test-password")).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("сторонний Google email не присваивается и не объединяет профили при совпадении", async () => {
    const existing = await createUser({ email: "existing@example.com" });
    const profile = googleProvider.toProfile({ sub: "other-sub", email: existing.email, email_verified: true });
    const user = await loginWithProfile("GOOGLE", profile);
    expect(user.id).not.toBe(existing.id);
    expect(user).toMatchObject({ email: null, emailVerifiedAt: null });
    expect(await prisma.authIdentity.count({ where: { userId: existing.id } })).toBe(0);
  });

  it("заблокированный пользователь не входит ни через существующую привязку, ни при автопривязке", async () => {
    const blocked = await createUser({ email: "blocked@example.com" });
    await prisma.user.update({ where: { id: blocked.id }, data: { status: "BLOCKED" } });

    await expect(loginWithProfile("GOOGLE", google("g-4", "blocked@example.com"))).rejects.toMatchObject({ code: "EXPLICIT_LINK_REQUIRED" });

    await prisma.authIdentity.create({ data: { userId: blocked.id, provider: "TELEGRAM", providerId: "555", verifiedAt: new Date() } });
    await expect(loginWithProfile("TELEGRAM", telegram("555"))).rejects.toMatchObject({ code: "ACCOUNT_BLOCKED" });
  });

  it("пять параллельных первых входов одного Telegram-аккаунта создают одного пользователя", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => loginWithProfile("TELEGRAM", telegram("777"))));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof loginWithProfile>>> => r.status === "fulfilled");

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.authIdentity.count()).toBe(1);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
  });

  it("у пользователя уже есть другой Google: конфликт, а не 500", async () => {
    const user = await createUser({ email: "dual@example.com" });
    await prisma.authIdentity.create({ data: { userId: user.id, provider: "GOOGLE", providerId: "old-sub", verifiedAt: new Date() } });
    await expect(loginWithProfile("GOOGLE", google("new-sub", "dual@example.com"))).rejects.toMatchObject({
      code: "EXPLICIT_LINK_REQUIRED",
    });
  });
});

describe("привязка к вошедшему пользователю", () => {
  it("привязывает Telegram к существующему профилю", async () => {
    const user = await createUser();
    await linkFor(user.id, "TELEGRAM", telegram("42"));
    expect(await listLinkedProviders(user.id)).toEqual(["TELEGRAM"]);
    // и теперь вход через Telegram ведёт в этот же профиль
    expect((await loginWithProfile("TELEGRAM", telegram("42"))).id).toBe(user.id);
  });

  it("повторная привязка того же аккаунта идемпотентна", async () => {
    const user = await createUser();
    await linkFor(user.id, "TELEGRAM", telegram("42"));
    await expect(linkFor(user.id, "TELEGRAM", telegram("42"))).resolves.toBeUndefined();
    expect(await prisma.authIdentity.count({ where: { userId: user.id } })).toBe(1);
  });

  it("аккаунт, привязанный к другому профилю: IDENTITY_TAKEN", async () => {
    const owner = await createUser();
    const other = await createUser();
    await linkFor(owner.id, "TELEGRAM", telegram("42"));
    await expect(linkFor(other.id, "TELEGRAM", telegram("42"))).rejects.toMatchObject({ code: "IDENTITY_TAKEN" });
  });

  it("второй аккаунт того же сервиса: PROVIDER_ALREADY_LINKED", async () => {
    const user = await createUser();
    await linkFor(user.id, "TELEGRAM", telegram("42"));
    await expect(linkFor(user.id, "TELEGRAM", telegram("43"))).rejects.toMatchObject({ code: "PROVIDER_ALREADY_LINKED" });
  });

  it("Google подтягивает email пользователю без почты (например, пришёл из Telegram)", async () => {
    const user = await createUser({ email: null });
    await linkFor(user.id, "GOOGLE", google("g-9", "fresh@gmail.com"));
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.email).toBe("fresh@gmail.com");
    expect(updated.emailVerifiedAt).not.toBeNull();
  });

  it("если email Google уже у другого пользователя, привязка идёт, но чужой email не присваивается", async () => {
    await createUser({ email: "taken@gmail.com" });
    const user = await createUser({ email: null });
    await linkFor(user.id, "GOOGLE", google("g-10", "taken@gmail.com"));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBeNull();
    expect(await listLinkedProviders(user.id)).toEqual(["GOOGLE"]);
  });

  it("существующий email пользователя Google не перезаписывает", async () => {
    const user = await createUser({ email: "mine@example.com" });
    await linkFor(user.id, "GOOGLE", google("g-11", "other@gmail.com"));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("mine@example.com");
  });

  it("совпавший сторонний адрес при привязке требует локального подтверждения", async () => {
    const user = await createUser({ email: "mine@example.com" });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
    const profile = googleProvider.toProfile({ sub: "g-12", email: user.email, email_verified: true });
    await linkFor(user.id, "GOOGLE", profile);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .toMatchObject({ email: user.email, emailVerifiedAt: null });
    expect(await listLinkedProviders(user.id)).toEqual(["GOOGLE"]);
  });

  it("заблокированный пользователь ничего не привязывает", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: "BLOCKED" } });
    await expect(linkFor(user.id, "TELEGRAM", telegram("42"))).rejects.toMatchObject({ code: "ACCOUNT_BLOCKED" });
  });
});
