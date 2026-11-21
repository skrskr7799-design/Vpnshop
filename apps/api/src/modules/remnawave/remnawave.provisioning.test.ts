import { describe, expect, it } from "vitest";
import { addMonths, computeTargetExpireAt } from "./remnawave.dates";
import { RemnawaveError } from "./remnawave.errors";
import { PANEL_USER } from "./remnawave.fixtures";
import { applySubscription, planExpiry, type RemnawaveApi } from "./remnawave.provisioning";
import { remnawaveUserSchema, type RemnawaveUser } from "./remnawave.schemas";
import { remnawaveUsernameFor } from "./remnawave.username";

const d = (iso: string) => new Date(iso);

describe("addMonths", () => {
  it.each([
    ["2030-01-15T10:00:00.000Z", 1, "2030-02-15T10:00:00.000Z"],
    ["2030-01-31T10:00:00.000Z", 1, "2030-02-28T10:00:00.000Z"], // конец месяца не «переливается»
    ["2032-01-31T10:00:00.000Z", 1, "2032-02-29T10:00:00.000Z"], // високосный год
    ["2030-11-30T23:59:59.000Z", 3, "2031-02-28T23:59:59.000Z"], // переход через год
    ["2030-08-31T00:00:00.000Z", 6, "2031-02-28T00:00:00.000Z"],
    ["2030-03-31T12:00:00.000Z", 6, "2030-09-30T12:00:00.000Z"],
  ])("%s + %i мес. = %s", (from, months, expected) => {
    expect(addMonths(d(from), months).toISOString()).toBe(expected);
  });
});

describe("computeTargetExpireAt", () => {
  const now = d("2030-06-10T12:00:00.000Z");

  it("действующая подписка продлевается от её конца", () => {
    expect(computeTargetExpireAt(d("2030-06-20T12:00:00.000Z"), 1, now).toISOString()).toBe("2030-07-20T12:00:00.000Z");
  });
  it("истёкшая отсчитывается от текущего момента", () => {
    expect(computeTargetExpireAt(d("2030-06-01T12:00:00.000Z"), 1, now).toISOString()).toBe("2030-07-10T12:00:00.000Z");
  });
  it("новая подписка тоже от текущего момента", () => {
    expect(computeTargetExpireAt(null, 3, now).toISOString()).toBe("2030-09-10T12:00:00.000Z");
  });
});

// Минимальная «панель» в памяти: достаточно, чтобы проверить логику применения подписки
function fakePanel(initial?: Partial<RemnawaveUser> & { id?: number }) {
  let user: RemnawaveUser | null = initial
    ? remnawaveUserSchema.parse({ ...PANEL_USER, ...initial, expireAt: (initial.expireAt ?? d(PANEL_USER.expireAt)).toISOString() })
    : null;
  const calls: string[] = [];
  const failures: { createFailsAfterSuccess?: boolean; createThrows?: RemnawaveError } = {};

  const api: RemnawaveApi = {
    async getUserByUsername() {
      calls.push("get");
      return user;
    },
    async createUser(input) {
      calls.push("create");
      if (failures.createThrows) throw failures.createThrows;
      user = remnawaveUserSchema.parse({
        ...PANEL_USER,
        username: input.username,
        expireAt: input.expireAt.toISOString(),
        hwidDeviceLimit: input.hwidDeviceLimit,
        status: "ACTIVE",
      });
      if (failures.createFailsAfterSuccess) {
        // панель создала пользователя, но ответ потерялся
        throw new RemnawaveError("unavailable", null, "timeout");
      }
      return user;
    },
    async updateUser(input) {
      calls.push("update");
      if (!user) throw new Error("no user");
      user = {
        ...user,
        ...(input.expireAt && { expireAt: input.expireAt }),
        ...(input.status && { status: input.status }),
        ...(input.hwidDeviceLimit !== undefined && { hwidDeviceLimit: input.hwidDeviceLimit }),
      };
      return user;
    },
  };
  return { api, calls, failures, current: () => user };
}

const input = {
  username: remnawaveUsernameFor("0f8fad5b-d9cb-469f-a165-70867728950e"),
  targetExpireAt: d("2030-07-10T12:00:00.000Z"),
  deviceLimit: 5,
  internalSquadUuids: ["11111111-1111-4111-8111-111111111111"],
};

describe("applySubscription", () => {
  it("создаёт пользователя, если его нет", async () => {
    const panel = fakePanel();
    const result = await applySubscription(panel.api, input);
    expect(result.created).toBe(true);
    expect(panel.calls).toEqual(["get", "create"]);
    expect(panel.current()).toMatchObject({ hwidDeviceLimit: 5, status: "ACTIVE" });
    expect(panel.current()!.expireAt.toISOString()).toBe("2030-07-10T12:00:00.000Z");
  });

  it("существующему ставит абсолютную дату и лимит устройств", async () => {
    const panel = fakePanel({ expireAt: d("2030-06-10T12:00:00.000Z"), hwidDeviceLimit: 3 });
    const result = await applySubscription(panel.api, input);
    expect(result.created).toBe(false);
    expect(panel.calls).toEqual(["get", "update"]);
    expect(panel.current()!.expireAt.toISOString()).toBe("2030-07-10T12:00:00.000Z");
    expect(panel.current()!.hwidDeviceLimit).toBe(5);
  });

  it("истёкшего возвращает в ACTIVE", async () => {
    const panel = fakePanel({ status: "EXPIRED", expireAt: d("2030-01-01T00:00:00.000Z") });
    await applySubscription(panel.api, input);
    expect(panel.current()!.status).toBe("ACTIVE");
  });

  it("отключённого вручную не включает, но сообщает об этом", async () => {
    const panel = fakePanel({ status: "DISABLED" });
    const result = await applySubscription(panel.api, input);
    expect(panel.current()!.status).toBe("DISABLED");
    expect(result.stillDisabled).toBe(true);
  });

  it("повтор не удлиняет срок дважды (идемпотентность)", async () => {
    const panel = fakePanel({ expireAt: d("2030-06-10T12:00:00.000Z") });
    await applySubscription(panel.api, input);
    const afterFirst = panel.current()!.expireAt.toISOString();
    await applySubscription(panel.api, input);
    await applySubscription(panel.api, input);
    expect(panel.current()!.expireAt.toISOString()).toBe(afterFirst);
  });

  it("потерянный ответ на создание: повтор находит созданного и не плодит дубль", async () => {
    const panel = fakePanel();
    panel.failures.createFailsAfterSuccess = true;
    await expect(applySubscription(panel.api, input)).rejects.toMatchObject({ kind: "unavailable" });

    // следующая попытка: пользователь уже есть, идёт обновление
    panel.failures.createFailsAfterSuccess = false;
    const result = await applySubscription(panel.api, input);
    expect(result.created).toBe(false);
    expect(panel.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(panel.current()!.expireAt.toISOString()).toBe("2030-07-10T12:00:00.000Z");
  });

  it("если создание отклонено (имя занято), а пользователь найден: продолжает обновлением", async () => {
    const racedUser = remnawaveUserSchema.parse({ ...PANEL_USER, username: input.username });
    let lookups = 0;
    const api: RemnawaveApi = {
      // первый get: пользователя ещё нет; после «гонки» он появился
      getUserByUsername: async () => (lookups++ === 0 ? null : racedUser),
      createUser: async () => {
        throw new RemnawaveError("rejected", 400, "username already exists");
      },
      updateUser: async (patch) => ({ ...racedUser, ...(patch.expireAt && { expireAt: patch.expireAt }) }),
    };
    const result = await applySubscription(api, input);
    expect(result.created).toBe(true);
    expect(result.user.expireAt.toISOString()).toBe("2030-07-10T12:00:00.000Z");
  });

  it("недоступность панели пробрасывается (задача повторит)", async () => {
    const panel = fakePanel();
    panel.failures.createThrows = new RemnawaveError("unavailable", 503, "down");
    await expect(applySubscription(panel.api, input)).rejects.toMatchObject({ retryable: true });
  });

  it("если создание отклонено, а пользователя нет: ошибка не скрывается", async () => {
    const api: RemnawaveApi = {
      getUserByUsername: async () => null,
      createUser: async () => {
        throw new RemnawaveError("rejected", 400, "bad username");
      },
      updateUser: async () => {
        throw new Error("unreachable");
      },
    };
    await expect(applySubscription(api, input)).rejects.toMatchObject({ kind: "rejected" });
  });
});

describe("planExpiry", () => {
  it("считает дату от состояния панели", async () => {
    const panel = fakePanel({ expireAt: d("2030-06-20T12:00:00.000Z") });
    const target = await planExpiry(panel.api, input.username, 3, d("2030-06-10T12:00:00.000Z"));
    expect(target.toISOString()).toBe("2030-09-20T12:00:00.000Z");
  });
});

describe("remnawaveUsernameFor", () => {
  it("детерминирован и отвергает не-UUID", () => {
    expect(remnawaveUsernameFor("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe("vs_0f8fad5bd9cb469fa16570867728950e");
    expect(() => remnawaveUsernameFor("not-a-uuid")).toThrow();
  });
});
