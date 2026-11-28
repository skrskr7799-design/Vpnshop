import { z } from "zod";

// Схемы описывают только то, чем мы пользуемся. Лишние поля игнорируются, поэтому новые поля
// в ответах панели нас не ломают. Источник: официальный контракт @remnawave/backend-contract
// (тесты remnawave.contract.test.ts сверяют нас с ним).

export const USER_STATUSES = ["ACTIVE", "DISABLED", "LIMITED", "EXPIRED"] as const;
export type RemnawaveUserStatus = (typeof USER_STATUSES)[number];

const isoDate = z.iso.datetime().transform((value) => new Date(value));

export const remnawaveUserSchema = z.object({
  id: z.number().int().positive(), // в API 3.x пользователь адресуется по числовому id или username
  description: z.string().nullable().optional(),
  shortUuid: z.string(),
  username: z.string(),
  status: z.enum(USER_STATUSES),
  trafficLimitBytes: z.number(),
  expireAt: isoDate,
  hwidDeviceLimit: z.number().int().nullable(),
  // Готовая ссылка подписки: строить её самим не нужно
  subscriptionUrl: z.string(),
  activeInternalSquads: z.array(z.object({ uuid: z.string(), name: z.string() })),
});
export type RemnawaveUser = z.infer<typeof remnawaveUserSchema>;

// Все ответы панели приходят в обёртке { response: ... }
const envelope = <T extends z.ZodType>(schema: T) => z.object({ response: schema });

export const userResponseSchema = envelope(remnawaveUserSchema);
export const internalSquadsResponseSchema = envelope(
  z.object({ internalSquads: z.array(z.object({ uuid: z.string(), name: z.string() })) }),
);
export const metadataResponseSchema = envelope(z.object({ version: z.string() }));

export const hwidDevicesResponseSchema = envelope(z.object({
  total: z.number().int().nonnegative(),
  devices: z.array(z.object({
    userId: z.number().int().positive(),
    platform: z.string().nullable(),
    deviceModel: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })),
}));
