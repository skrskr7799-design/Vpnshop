import {
  CreateUserCommand,
  GetInternalSquadsCommand,
  GetMetadataCommand,
  GetUserByUsernameCommand,
  UpdateUserCommand,
} from "@remnawave/backend-contract";
import { describe, expect, it } from "vitest";
import { REMNAWAVE_ROUTES, toCreateBody, toUpdateBody } from "./remnawave.client";
import { PANEL_USER } from "./remnawave.fixtures";
import { remnawaveUserSchema } from "./remnawave.schemas";
import { remnawaveUsernameFor } from "./remnawave.username";

// Сверка с ОФИЦИАЛЬНЫМ контрактом панели. Пакет @remnawave/backend-contract стоит как devDependency
// с точной версией (3.4.17 = панель 3.4.9). Пакет под AGPL-3.0, поэтому в рабочий код он не попадает:
// клиент использует собственные схемы, а контракт нужен тут, чтобы заметить расхождение при обновлении.
describe("контракт Remnawave 3.4.17", () => {
  it("маршруты и методы совпадают с официальными", () => {
    expect(REMNAWAVE_ROUTES.users).toBe(CreateUserCommand.url);
    expect(REMNAWAVE_ROUTES.users).toBe(UpdateUserCommand.url);
    expect(REMNAWAVE_ROUTES.userByUsername("vs_abc")).toBe(GetUserByUsernameCommand.url("vs_abc"));
    expect(REMNAWAVE_ROUTES.internalSquads).toBe(GetInternalSquadsCommand.url);
    expect(REMNAWAVE_ROUTES.metadata).toBe(GetMetadataCommand.url);

    expect(CreateUserCommand.endpointDetails.REQUEST_METHOD.toLowerCase()).toBe("post");
    expect(UpdateUserCommand.endpointDetails.REQUEST_METHOD.toLowerCase()).toBe("patch");
    expect(GetUserByUsernameCommand.endpointDetails.REQUEST_METHOD.toLowerCase()).toBe("get");
  });

  it("тело создания пользователя проходит официальную валидацию", () => {
    const body = toCreateBody({
      username: remnawaveUsernameFor("0f8fad5b-d9cb-469f-a165-70867728950e"),
      expireAt: new Date("2030-01-31T10:00:00.000Z"),
      hwidDeviceLimit: 5,
      activeInternalSquads: ["11111111-1111-4111-8111-111111111111"],
    });
    const parsed = CreateUserCommand.RequestBodySchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("тело обновления проходит официальную валидацию (в том числе правило «дата в будущем»)", () => {
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const parsed = UpdateUserCommand.RequestBodySchema.safeParse(
      toUpdateBody({ id: 7, expireAt: future, status: "ACTIVE", hwidDeviceLimit: 5 }),
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("официальный контракт требует id или username в обновлении (мы всегда шлём id)", () => {
    expect(UpdateUserCommand.RequestBodySchema.safeParse({ hwidDeviceLimit: 5 }).success).toBe(false);
  });

  it("username проходит правила панели: 3-36 символов, буквы/цифры/_/-", () => {
    const username = remnawaveUsernameFor("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(username).toHaveLength(35);
    const parsed = CreateUserCommand.RequestBodySchema.shape.username.safeParse(username);
    expect(parsed.success).toBe(true);
  });

  it("образец ответа валиден по официальной схеме и разбирается нашей", () => {
    const official = GetUserByUsernameCommand.ResponseSchema.safeParse({ response: PANEL_USER });
    expect(official.success, JSON.stringify(official.error?.issues)).toBe(true);

    const ours = remnawaveUserSchema.parse(PANEL_USER);
    expect(ours.id).toBe(PANEL_USER.id);
    expect(ours.subscriptionUrl).toBe(PANEL_USER.subscriptionUrl);
  });
});
