import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env";
import { AppError } from "./errors";

export const keysetQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});

type Key = { id: string; createdAt: Date };
const payload = z.tuple([z.string().min(1).max(128), z.iso.datetime()]);
const sign = (scope: string, encoded: string) =>
  createHmac("sha256", (env.MZT_PROCESS === "admin" ? env.ADMIN_ENCRYPTION_KEY : env.JWT_SECRET)!).update(JSON.stringify(["mzt-keyset-v1", scope, encoded])).digest("base64url");

export function keysetWhere(scope: string, cursor?: string) {
  if (!cursor) return {};
  try {
    const [encoded, mac, extra] = cursor.split(".");
    if (!encoded || !mac || extra !== undefined) throw new Error();
    const x = Buffer.from(mac);
    const y = Buffer.from(sign(scope, encoded));
    if (x.length !== y.length || !timingSafeEqual(x, y)) throw new Error();
    const [id, timestamp] = payload.parse(JSON.parse(Buffer.from(encoded, "base64url").toString()));
    const createdAt = new Date(timestamp);
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
  } catch {
    throw new AppError(400, "INVALID_CURSOR");
  }
}

export function keysetPage<T extends Key, R>(scope: string, rows: T[], limit: number, map: (row: T) => R) {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  const encoded = rows.length > limit && last ? Buffer.from(JSON.stringify([last.id, last.createdAt.toISOString()])).toString("base64url") : null;
  return { items: visible.map(map), nextCursor: encoded ? `${encoded}.${sign(scope, encoded)}` : null };
}
export const newestFirst = [{ createdAt: "desc" as const }, { id: "desc" as const }];
