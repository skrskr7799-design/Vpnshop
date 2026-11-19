import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./ApiError";
import { request, setSessionExpiredHandler } from "./client";

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const err = (status: number, code: string) => json(status, { error: { code } });

const fetchMock = vi.fn<typeof fetch>();
const urls = () => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setSessionExpiredHandler(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("request: обновление сессии", () => {
  it("на 401 UNAUTHENTICATED обновляет сессию и повторяет запрос", async () => {
    fetchMock
      .mockResolvedValueOnce(err(401, "UNAUTHENTICATED"))
      .mockResolvedValueOnce(json(204)) // /auth/refresh
      .mockResolvedValueOnce(json(200, { user: { id: "1" } }));

    await expect(request("/auth/me")).resolves.toEqual({ user: { id: "1" } });
    expect(urls()).toEqual(["/api/auth/me", "/api/auth/refresh", "/api/auth/me"]);
  });

  it("параллельные 401 делят один refresh", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) return json(204);
      const retried = fetchMock.mock.calls.filter(([u]) => String(u) === url).length > 1;
      return retried ? json(200, { ok: url }) : err(401, "UNAUTHENTICATED");
    });

    const results = await Promise.all([request("/a"), request("/b"), request("/c")]);
    expect(results).toHaveLength(3);
    expect(urls().filter((u) => u.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("если refresh отклонён, сообщает об истёкшей сессии и бросает исходную ошибку", async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    fetchMock
      .mockResolvedValueOnce(err(401, "UNAUTHENTICATED"))
      .mockResolvedValueOnce(err(401, "INVALID_SESSION"));

    await expect(request("/auth/me")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(expired).toHaveBeenCalledOnce();
  });

  it("при REFRESH_RACE повторяет refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(err(401, "UNAUTHENTICATED"))
      .mockResolvedValueOnce(err(401, "REFRESH_RACE"))
      .mockResolvedValueOnce(json(204))
      .mockResolvedValueOnce(json(200, { ok: true }));

    await expect(request("/x")).resolves.toEqual({ ok: true });
    expect(urls().filter((u) => u.endsWith("/auth/refresh"))).toHaveLength(2);
  });

  it("сетевая ошибка при refresh не разлогинивает", async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    fetchMock
      .mockResolvedValueOnce(err(401, "UNAUTHENTICATED"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(request("/x")).rejects.toBeInstanceOf(TypeError);
    expect(expired).not.toHaveBeenCalled();
  });

  it("не обновляет сессию для запросов с skipRefresh", async () => {
    fetchMock.mockResolvedValueOnce(err(401, "INVALID_CREDENTIALS"));
    await expect(request("/auth/login", { method: "POST", body: {}, skipRefresh: true })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("повторяет исходный запрос только один раз", async () => {
    fetchMock
      .mockResolvedValueOnce(err(401, "UNAUTHENTICATED"))
      .mockResolvedValueOnce(json(204))
      .mockResolvedValueOnce(err(401, "UNAUTHENTICATED"));

    await expect(request("/x")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("отправляет Content-Type только вместе с телом", async () => {
    fetchMock.mockResolvedValue(json(204));
    await request("/auth/logout", { method: "POST" });
    await request("/auth/login", { method: "POST", body: { a: 1 } });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
  });
});
