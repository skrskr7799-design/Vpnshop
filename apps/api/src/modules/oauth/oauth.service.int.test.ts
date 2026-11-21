import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { linkProfile, listLinkedProviders, loginWithProfile } from "./oauth.service";
import type { ProviderProfile } from "./oauth.types";

const google = (sub: string, email: string | null, emailVerified = true): ProviderProfile => ({
  providerId: sub,
  email,
  emailVerified,
});
const telegram = (id: string): ProviderProfile => ({ providerId: id, email: null, emailVerified: false });

beforeEach(resetDatabase);

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

  it("Google с email существующего пользователя: привязывается к нему, дубля нет", async () => {
    const existing = await createUser({ email: "same@example.com" });
    await prisma.authIdentity.create({
      data: { userId: existing.id, provider: "EMAIL", providerId: "same@example.com", passwordHash: "x", verifiedAt: new Date() },
    });

    const user = await loginWithProfile("GOOGLE", google("g-2", "same@example.com"));

    expect(user.id).toBe(existing.id);
    expect(await prisma.user.count()).toBe(1);
    expect((await listLinkedProviders(existing.id)).sort()).toEqual(["EMAIL", "GOOGLE"]);
  });

  it("Google с НЕподтверждённой почтой: отказ, ничего не создаётся", async () => {
    await expect(loginWithProfile("GOOGLE", google("g-3", "x@gmail.com", false))).rejects.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.authIdentity.count()).toBe(0);
  });

  it("неподтверждённый Google email не позволяет «подцепиться» к чужому аккаунту", async () => {
    const victim = await createUser({ email: "victim@example.com" });
    await expect(loginWithProfile("GOOGLE", google("evil", "victim@example.com", false))).rejects.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
    expect(await prisma.authIdentity.count({ where: { userId: victim.id } })).toBe(0);
  });

  it("заблокированный пользователь не входит ни через существующую привязку, ни при автопривязке", async () => {
    const blocked = await createUser({ email: "blocked@example.com" });
    await prisma.user.update({ where: { id: blocked.id }, data: { status: "BLOCKED" } });

    await expect(loginWithProfile("GOOGLE", google("g-4", "blocked@example.com"))).rejects.toMatchObject({ code: "ACCOUNT_BLOCKED" });

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
      code: "PROVIDER_ALREADY_LINKED",
    });
  });
});

describe("привязка к вошедшему пользователю", () => {
  it("привязывает Telegram к существующему профилю", async () => {
    const user = await createUser();
    await linkProfile(user.id, "TELEGRAM", telegram("42"));
    expect(await listLinkedProviders(user.id)).toEqual(["TELEGRAM"]);
    // и теперь вход через Telegram ведёт в этот же профиль
    expect((await loginWithProfile("TELEGRAM", telegram("42"))).id).toBe(user.id);
  });

  it("повторная привязка того же аккаунта идемпотентна", async () => {
    const user = await createUser();
    await linkProfile(user.id, "TELEGRAM", telegram("42"));
    await expect(linkProfile(user.id, "TELEGRAM", telegram("42"))).resolves.toBeUndefined();
    expect(await prisma.authIdentity.count({ where: { userId: user.id } })).toBe(1);
  });

  it("аккаунт, привязанный к другому профилю: IDENTITY_TAKEN", async () => {
    const owner = await createUser();
    const other = await createUser();
    await linkProfile(owner.id, "TELEGRAM", telegram("42"));
    await expect(linkProfile(other.id, "TELEGRAM", telegram("42"))).rejects.toMatchObject({ code: "IDENTITY_TAKEN" });
  });

  it("второй аккаунт того же сервиса: PROVIDER_ALREADY_LINKED", async () => {
    const user = await createUser();
    await linkProfile(user.id, "TELEGRAM", telegram("42"));
    await expect(linkProfile(user.id, "TELEGRAM", telegram("43"))).rejects.toMatchObject({ code: "PROVIDER_ALREADY_LINKED" });
  });

  it("Google подтягивает email пользователю без почты (например, пришёл из Telegram)", async () => {
    const user = await createUser({ email: null });
    await linkProfile(user.id, "GOOGLE", google("g-9", "fresh@gmail.com"));
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.email).toBe("fresh@gmail.com");
    expect(updated.emailVerifiedAt).not.toBeNull();
  });

  it("если email Google уже у другого пользователя, привязка идёт, но чужой email не присваивается", async () => {
    await createUser({ email: "taken@gmail.com" });
    const user = await createUser({ email: null });
    await linkProfile(user.id, "GOOGLE", google("g-10", "taken@gmail.com"));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBeNull();
    expect(await listLinkedProviders(user.id)).toEqual(["GOOGLE"]);
  });

  it("существующий email пользователя Google не перезаписывает", async () => {
    const user = await createUser({ email: "mine@example.com" });
    await linkProfile(user.id, "GOOGLE", google("g-11", "other@gmail.com"));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("mine@example.com");
  });

  it("заблокированный пользователь ничего не привязывает", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: "BLOCKED" } });
    await expect(linkProfile(user.id, "TELEGRAM", telegram("42"))).rejects.toMatchObject({ code: "ACCOUNT_BLOCKED" });
  });
});
