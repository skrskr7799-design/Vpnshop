import type { FastifyBaseLogger } from "fastify";
import { beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { sendMail } from "../mail/mail.service";
import { createEmailAccount, forgotPassword } from "./auth.service";
import { hashPassword } from "./password";

vi.mock("../../config/env", async importOriginal => ({
  ...await importOriginal<typeof import("../../config/env")>(), emailAvailable: false,
}));
vi.mock("../mail/mail.service", () => ({ sendMail: vi.fn() }));
beforeEach(resetDatabase);

it("accepts a pending signup without SMTP, keeps the reset response neutral and queues no mail", async () => {
  const api = await buildApp();
  try {
    const email = "pending-mail@example.com";
    const password = "synthetic-password-for-activation";
    const send = (url: string, payload: object) => api.inject({ method: "POST", url, payload, headers: { origin: env.WEB_ORIGIN } });
    const queued = await send("/api/auth/register", { email, password });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toEqual({ ok: true, emailAvailable: false });
    expect(await prisma.pendingRegistration.count({ where: { email } })).toBe(1);
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const verified = "verified-mail@example.com";
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(db => createEmailAccount(db, { email: verified, passwordHash, emailVerifiedAt: new Date() }));
    const real = await send("/api/auth/forgot-password", { email: verified });
    const unknown = await send("/api/auth/forgot-password", { email: "nobody@example.com" });
    expect(real.statusCode).toBe(202);
    expect(real.json()).toEqual(unknown.json());
    await forgotPassword({ email: verified }, { log: {} as FastifyBaseLogger });
    expect(await prisma.verificationToken.count()).toBe(0);
    expect(await prisma.notificationOutbox.count()).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  } finally {
    await api.close();
  }
});
