import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma";
import { createJob, createOrder, createUser } from "../../test/factories";
import { resetDatabase } from "../../test/db";
import { addMonths } from "../remnawave/remnawave.dates";
import { RemnawaveError } from "../remnawave/remnawave.errors";
import { createFakePanel } from "../remnawave/remnawave.testing";
import { remnawaveUsernameFor } from "../remnawave/remnawave.username";
import { BACKOFF_MAX_MS, MAX_ATTEMPTS, OPERATOR_RETRY_MS } from "./fulfillment.constants";
import { enqueueFulfillment, requeueFailedJob } from "./fulfillment.queue";
import { createFulfillmentWorker } from "./fulfillment.worker";

// Тесты идут против настоящего Postgres: проверяем атомарный захват, порядок задач и транзакции.
const SQUADS = ["11111111-1111-4111-8111-111111111111"];
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let clock: Date;
let panel: ReturnType<typeof createFakePanel>;
const logs = { error: [] as string[], warn: [] as string[] };
const log = {
  info: () => {},
  warn: (_: object, msg: string) => void logs.warn.push(msg),
  error: (_: object, msg: string) => void logs.error.push(msg),
};

const makeWorker = () =>
  createFulfillmentWorker({ api: panel.api, internalSquadUuids: SQUADS, log, now: () => clock });
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
const job = (id: string) => prisma.fulfillmentJob.findUniqueOrThrow({ where: { id } });
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDatabase();
  clock = new Date("2030-06-10T12:00:00.000Z");
  panel = createFakePanel();
  logs.error.length = 0;
  logs.warn.length = 0;
});

describe("выдача подписки", () => {
  it("новому пользователю: создаёт его в панели, закрывает задачу и заказ, запоминает id", async () => {
    const user = await createUser();
    const o = await createOrder(user.id, { months: 3, deviceLimit: 5 });
    const j = await createJob(o.id);

    expect(await makeWorker().tick()).toBe(1);

    const created = panel.get(remnawaveUsernameFor(user.id))!;
    expect(created.hwidDeviceLimit).toBe(5);
    expect(created.expireAt.toISOString()).toBe(addMonths(clock, 3).toISOString());

    expect(await job(j.id)).toMatchObject({ status: "DONE", attempts: 1, lockedAt: null, lastError: null });
    expect(await order(o.id)).toMatchObject({ status: "FULFILLED" });
    expect((await order(o.id)).fulfilledAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).remnawaveUserId).toBe(created.id);
  });

  it("продление: действующая подписка продлевается от её конца", async () => {
    const user = await createUser();
    const expiresIn10Days = new Date(clock.getTime() + 10 * DAY);
    panel.seed(remnawaveUsernameFor(user.id), { expireAt: expiresIn10Days });
    const o = await createOrder(user.id, { months: 1 });
    await createJob(o.id);

    await makeWorker().tick();

    expect(panel.get(remnawaveUsernameFor(user.id))!.expireAt.toISOString()).toBe(
      addMonths(expiresIn10Days, 1).toISOString(),
    );
  });

  it("истёкший пользователь возвращается в ACTIVE, срок считается от сегодня", async () => {
    const user = await createUser();
    panel.seed(remnawaveUsernameFor(user.id), { expireAt: new Date(clock.getTime() - 5 * DAY), status: "EXPIRED" });
    const o = await createOrder(user.id, { months: 1 });
    await createJob(o.id);

    await makeWorker().tick();

    const p = panel.get(remnawaveUsernameFor(user.id))!;
    expect(p.status).toBe("ACTIVE");
    expect(p.expireAt.toISOString()).toBe(addMonths(clock, 1).toISOString());
  });

  it("отключённого в панели вручную не включает, но продлевает и помечает задачу", async () => {
    const user = await createUser();
    panel.seed(remnawaveUsernameFor(user.id), { expireAt: new Date(clock.getTime() + DAY), status: "DISABLED" });
    const o = await createOrder(user.id);
    const j = await createJob(o.id);

    await makeWorker().tick();

    expect(panel.get(remnawaveUsernameFor(user.id))!.status).toBe("DISABLED");
    const done = await job(j.id);
    expect(done.status).toBe("DONE");
    expect(done.lastError).toContain("DISABLED");
    expect(logs.warn.join()).toContain("DISABLED");
  });

  it("не трогает задачи, время которых ещё не пришло", async () => {
    const user = await createUser();
    const o = await createOrder(user.id);
    const j = await createJob(o.id);
    await prisma.fulfillmentJob.update({ where: { id: j.id }, data: { nextAttemptAt: new Date(clock.getTime() + MIN) } });

    expect(await makeWorker().tick()).toBe(0);
    expect(panel.calls.get + panel.calls.create).toBe(0);
  });
});

describe("постановка в очередь", () => {
  it("идемпотентна: повторный вебхук не создаёт вторую задачу", async () => {
    const user = await createUser();
    const o = await createOrder(user.id);
    await prisma.$transaction((tx) => enqueueFulfillment(tx, o.id));
    await prisma.$transaction((tx) => enqueueFulfillment(tx, o.id));
    expect(await prisma.fulfillmentJob.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("откат транзакции откатывает и задачу (нет задачи без оплаченного заказа)", async () => {
    const user = await createUser();
    const o = await createOrder(user.id);
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueFulfillment(tx, o.id);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await prisma.fulfillmentJob.count()).toBe(0);
  });
});

describe("повторы при сбоях", () => {
  it("панель недоступна: задача откладывается с паузой и выполняется позже", async () => {
    const user = await createUser();
    const o = await createOrder(user.id);
    const j = await createJob(o.id);
    const worker = makeWorker();

    panel.setDown(new RemnawaveError("unavailable", 503, "panel down"));
    await worker.tick();

    const retry = await job(j.id);
    expect(retry).toMatchObject({ status: "PENDING", attempts: 1, lockedAt: null });
    expect(retry.lastError).toContain("panel down");
    expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(clock.getTime());
    expect((await order(o.id)).status).toBe("PAID"); // заказ не трогаем, пока не выдано

    // сразу повторно не пытаемся
    const callsBefore = panel.calls.get;
    await worker.tick();
    expect(panel.calls.get).toBe(callsBefore);

    // панель вернулась, пауза прошла
    panel.setDown(null);
    advance(31 * MIN);
    await worker.tick();
    expect(await job(j.id)).toMatchObject({ status: "DONE", attempts: 2 });
    expect((await order(o.id)).status).toBe("FULFILLED");
  });

  it("исчерпанные попытки: задача FAILED, следующая задача пользователя ждёт, после requeue всё выполняется", async () => {
    const user = await createUser();
    const oA = await createOrder(user.id, { months: 1 });
    const oB = await createOrder(user.id, { months: 3 });
    const jA = await createJob(oA.id, new Date(clock.getTime() - 2000));
    const jB = await createJob(oB.id, new Date(clock.getTime() - 1000));
    const worker = makeWorker();

    panel.setDown(new RemnawaveError("unavailable", 503, "panel down"));
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await worker.tick();
      advance(BACKOFF_MAX_MS * 1.25); // с запасом на разброс паузы (до +20%)
    }

    expect(await job(jA.id)).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
    expect((await job(jA.id)).lastError).toContain("gave up");
    expect(await job(jB.id)).toMatchObject({ status: "PENDING", attempts: 0 }); // ждёт, пока разберутся с первой
    expect(logs.error.join()).toContain("попытки исчерпаны");

    panel.setDown(null);
    expect(await requeueFailedJob(jA.id, clock)).toBe(true);
    await worker.tick();

    expect((await job(jA.id)).status).toBe("DONE");
    expect((await job(jB.id)).status).toBe("DONE");
    // оба заказа учтены: 1 + 3 месяца
    expect(panel.get(remnawaveUsernameFor(user.id))!.expireAt.toISOString()).toBe(
      addMonths(addMonths(clock, 1), 3).toISOString(),
    );
  });

  it("отклонение панелью (rejected): сразу FAILED, без повторов", async () => {
    const user = await createUser();
    const o = await createOrder(user.id);
    const j = await createJob(o.id);
    panel.setDown(new RemnawaveError("rejected", 400, "bad request"));

    await makeWorker().tick();
    expect(await job(j.id)).toMatchObject({ status: "FAILED", attempts: 1 });
  });

  it("неверный токен: задача не сдаётся, ждёт оператора и выполняется после исправления", async () => {
    const user = await createUser();
    const o = await createOrder(user.id);
    const j = await createJob(o.id);
    const worker = makeWorker();

    panel.setDown(new RemnawaveError("unauthorized", 401, "unauthorized"));
    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
      await worker.tick();
      advance(OPERATOR_RETRY_MS + MIN);
    }
    expect(await job(j.id)).toMatchObject({ status: "PENDING" }); // не FAILED, сколько бы ни прошло попыток
    expect(logs.error.join()).toContain("оператора");

    panel.setDown(null);
    await worker.tick();
    expect((await job(j.id)).status).toBe("DONE");
  });

  it("заказ не в статусе PAID: задача останавливается, панель не трогаем", async () => {
    const user = await createUser();
    const o = await createOrder(user.id, { status: "REFUNDED" });
    const j = await createJob(o.id);

    await makeWorker().tick();
    expect((await job(j.id)).status).toBe("FAILED");
    expect(panel.calls.get + panel.calls.create + panel.calls.update).toBe(0);
  });

  it("заказ уже FULFILLED: задачу просто закрываем, повторно не выдаём", async () => {
    const user = await createUser();
    const o = await createOrder(user.id, { status: "FULFILLED" });
    const j = await createJob(o.id);

    await makeWorker().tick();
    expect((await job(j.id)).status).toBe("DONE");
    expect(panel.calls.get + panel.calls.create + panel.calls.update).toBe(0);
  });
});

describe("порядок и конкурентность", () => {
  it("два заказа одного пользователя обрабатываются строго по очереди: продления складываются", async () => {
    const user = await createUser();
    const base = new Date(clock.getTime() + 10 * DAY);
    panel.seed(remnawaveUsernameFor(user.id), { expireAt: base });
    const oA = await createOrder(user.id, { months: 1 });
    const oB = await createOrder(user.id, { months: 3 });
    const jA = await createJob(oA.id, new Date(clock.getTime() - 2000));
    const jB = await createJob(oB.id, new Date(clock.getTime() - 1000));
    const worker = makeWorker();

    // первая задача падает: вторая не должна обгонять и считать дату от старого состояния
    panel.setDown(new RemnawaveError("unavailable", 503, "down"));
    await worker.tick();
    expect((await job(jB.id)).attempts).toBe(0);

    panel.setDown(null);
    advance(31 * MIN);
    await worker.tick();

    expect(panel.get(remnawaveUsernameFor(user.id))!.expireAt.toISOString()).toBe(
      addMonths(addMonths(base, 1), 3).toISOString(),
    );
    expect((await job(jA.id)).status).toBe("DONE");
    expect((await job(jB.id)).status).toBe("DONE");
  });

  it("задачи разных пользователей не блокируют друг друга", async () => {
    const [u1, u2] = [await createUser(), await createUser()];
    const jobs = [];
    for (const u of [u1, u2]) jobs.push(await createJob((await createOrder(u.id)).id));
    expect(await makeWorker().tick()).toBe(2);
    expect(panel.calls.create).toBe(2);
  });

  it("несколько воркеров параллельно: каждая задача выполняется ровно один раз", async () => {
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      const user = await createUser();
      jobs.push(await createJob((await createOrder(user.id)).id));
    }

    const counts = await Promise.all([makeWorker().tick(), makeWorker().tick(), makeWorker().tick()]);

    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
    expect(panel.calls.create).toBe(6);
    for (const j of jobs) expect(await job(j.id)).toMatchObject({ status: "DONE", attempts: 1 });
  });
});

describe("восстановление после падения", () => {
  it("брошенная задача (процесс упал после обращения к панели) завершается без двойного продления", async () => {
    const user = await createUser();
    const target = addMonths(clock, 3);
    // Процесс успел применить дату в панели и умер, не записав результат в БД
    panel.seed(remnawaveUsernameFor(user.id), { expireAt: target });
    const o = await createOrder(user.id, { months: 3 });
    const j = await createJob(o.id);
    await prisma.fulfillmentJob.update({
      where: { id: j.id },
      data: { status: "RUNNING", attempts: 1, targetExpireAt: target, lockedAt: new Date(clock.getTime() - 10 * MIN) },
    });

    await makeWorker().tick();

    expect(await job(j.id)).toMatchObject({ status: "DONE", attempts: 2 });
    expect((await order(o.id)).status).toBe("FULFILLED");
    // срок остался прежним: не target + 3 месяца
    expect(panel.get(remnawaveUsernameFor(user.id))!.expireAt.toISOString()).toBe(target.toISOString());
  });

  it("свежая задача в RUNNING (идёт работа) не отбирается", async () => {
    const user = await createUser();
    const o = await createOrder(user.id);
    const j = await createJob(o.id);
    await prisma.fulfillmentJob.update({
      where: { id: j.id },
      data: { status: "RUNNING", attempts: 1, lockedAt: new Date(clock.getTime() - MIN) },
    });

    expect(await makeWorker().tick()).toBe(0);
    expect((await job(j.id)).status).toBe("RUNNING");
  });

  it("итоговая дата фиксируется при первой попытке и не пересчитывается при повторе", async () => {
    const user = await createUser();
    const o = await createOrder(user.id, { months: 1 });
    const j = await createJob(o.id);
    const worker = makeWorker();

    // панель принимает чтение, но падает на записи
    panel.seed(remnawaveUsernameFor(user.id), { expireAt: new Date(clock.getTime() + 10 * DAY) });
    const realUpdate = panel.api.updateUser;
    panel.api.updateUser = async () => {
      throw new RemnawaveError("unavailable", 503, "write failed");
    };
    await worker.tick();
    const firstTarget = (await job(j.id)).targetExpireAt!;
    expect(firstTarget).not.toBeNull();

    // через неделю повтор: дата не должна «уехать» вслед за часами
    panel.api.updateUser = realUpdate;
    advance(7 * DAY);
    await worker.tick();
    expect(panel.get(remnawaveUsernameFor(user.id))!.expireAt.toISOString()).toBe(firstTarget.toISOString());
  });
});
