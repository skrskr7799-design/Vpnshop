import { computeTargetExpireAt } from "./remnawave.dates";
import type { RemnawaveClient } from "./remnawave.client";
import { RemnawaveError } from "./remnawave.errors";
import type { RemnawaveUser } from "./remnawave.schemas";

// Нужны только эти операции клиента (так проще подменять в тестах)
export type RemnawaveApi = Pick<RemnawaveClient, "getUserByUsername" | "createUser" | "updateUser">;

export type ApplySubscriptionInput = {
  username: string;
  /** Итоговая дата окончания: считается один раз и хранится в задаче */
  targetExpireAt: Date;
  deviceLimit: number;
  /** Сквады для нового пользователя; у существующего не меняются */
  internalSquadUuids: string[];
};

export type ApplySubscriptionResult = {
  user: RemnawaveUser;
  created: boolean;
  /** Пользователь отключён в панели вручную: срок продлён, но включать его мы не стали */
  stillDisabled: boolean;
};

// Шаг 1 (один раз на задачу): вычислить итоговую дату от текущего состояния панели.
export async function planExpiry(
  api: Pick<RemnawaveApi, "getUserByUsername">,
  username: string,
  months: number,
  now: Date = new Date(),
): Promise<Date> {
  const current = await api.getUserByUsername(username);
  return computeTargetExpireAt(current?.expireAt ?? null, months, now);
}

// Шаг 2 (можно повторять сколько угодно): привести пользователя в панели к нужному состоянию.
// Всё задаётся абсолютными значениями, поэтому повтор после сбоя безопасен: срок не удлиняется дважды.
export async function applySubscription(
  api: RemnawaveApi,
  input: ApplySubscriptionInput,
): Promise<ApplySubscriptionResult> {
  let existing = await api.getUserByUsername(input.username);
  let created = false;

  if (!existing) {
    try {
      const user = await api.createUser({
        username: input.username,
        expireAt: input.targetExpireAt,
        hwidDeviceLimit: input.deviceLimit,
        activeInternalSquads: input.internalSquadUuids,
      });
      return { user, created: true, stillDisabled: false };
    } catch (err) {
      // Прошлая попытка могла создать пользователя, но не получить ответ (таймаут):
      // тогда панель отклонит создание, и мы просто продолжаем как с существующим.
      if (!(err instanceof RemnawaveError) || err.kind !== "rejected") throw err;
      existing = await api.getUserByUsername(input.username);
      if (!existing) throw err;
      created = true;
    }
  }

  const user = await api.updateUser({
    id: existing.id,
    expireAt: input.targetExpireAt,
    hwidDeviceLimit: input.deviceLimit,
    // Истёкшего пользователя возвращаем в ACTIVE. Отключённого вручную (бан) не трогаем.
    ...(existing.status === "EXPIRED" && { status: "ACTIVE" as const }),
  });
  return { user, created, stillDisabled: user.status === "DISABLED" };
}
