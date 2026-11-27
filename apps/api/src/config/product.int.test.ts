import { randomUUID } from "node:crypto";
import { publicProductConfig } from "@vpn/shared";
import { beforeEach, expect, it } from "vitest";
import { buildApp } from "../app";
import { prisma } from "../lib/prisma";
import { resetDatabase } from "../test/db";
import { createUser } from "../test/factories";
import { createSession } from "../modules/auth/session.service";
import { loginWithProfile } from "../modules/oauth/oauth.service";
import { env } from "./env";

beforeEach(resetDatabase);

it("returns versioned config over public HTTP and applies Core gates without hiding the support history", async () => {
  const app = await buildApp();
  const previous = { ...env };
  try {
    const user = await createUser();
    const { accessToken } = await createSession(user, {});
    const post = (url: string, payload: object) => app.inject({
      method: "POST", url, payload, cookies: { vpn_at: accessToken },
      headers: { origin: env.WEB_ORIGIN, "idempotency-key": randomUUID() },
    });
    expect((await post("/api/me/support/cases", { category: "OTHER", message: "Synthetic discussion" })).statusCode).toBe(201);
    const existing = await loginWithProfile("TELEGRAM", { email: null, emailVerified: false, providerId: "10001" });
    env.BRAND_NAME = '«Компания» "<script>пример</script>"';
    env.REGISTRATION_ENABLED = false;
    env.SUPPORT_ENABLED = false;
    env.PAYMENTS_ENABLED = false;
    const response = await app.inject({ url: "/api/config" });
    expect(response.headers["cache-control"]).toBe("no-store");
    const configuration = publicProductConfig.parse(response.json());
    expect(configuration.product.brandName).toBe(env.BRAND_NAME);
    expect(configuration.availability).toMatchObject({ registration: false, payments: false, support: false });
    expect(Object.keys(configuration).sort()).toEqual(["availability", "product", "version"]);
    expect((await post("/api/auth/register", { email: "blocked@example.invalid", password: "fixture-password" })).json().error.code)
      .toBe("REGISTRATION_CLOSED");
    await expect(loginWithProfile("GOOGLE", { email: "new@example.invalid", emailVerified: true, providerId: "new-subject" }))
      .rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    await expect(loginWithProfile("TELEGRAM", { email: null, emailVerified: false, providerId: "10002" }))
      .rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    await expect(loginWithProfile("TELEGRAM", { email: null, emailVerified: false, providerId: "10001" }))
      .resolves.toMatchObject({ id: existing.id });
    expect((await post("/api/me/support/cases", { category: "OTHER", message: "Synthetic discussion" })).json().error.code)
      .toBe("SUPPORT_DISABLED");
    const listing = await app.inject({ url: "/api/me/support/cases", cookies: { vpn_at: accessToken } });
    expect(listing.json().items).toHaveLength(1);
    expect(await prisma.pendingRegistration.count()).toBe(0);
    env.MAINTENANCE_MODE = true;
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await post("/api/auth/register", { email: "blocked@example.invalid", password: "fixture-password" })).json().error.code)
      .toBe("MAINTENANCE_MODE");
  } finally {
    Object.assign(env, previous);
    await app.close();
  }
});
