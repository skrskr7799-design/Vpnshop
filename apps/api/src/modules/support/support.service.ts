import type { Prisma, SupportCase, SupportMessage } from "@prisma/client";
import type { CaseSummary, staffSupportAction, supportCreate } from "@vpn/shared";
import type { z } from "zod";
import { sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { keysetPage, keysetWhere, newestFirst } from "../../lib/keyset";
import { prisma } from "../../lib/prisma";
import { writeAudit } from "../admin/admin.audit";
import { dbNow } from "../commerce/offers";

type PageInput = { limit: number; cursor?: string };
type Create = z.infer<typeof supportCreate>;
type StaffAction = z.infer<typeof staffSupportAction>;

export function summary(row: SupportCase): CaseSummary {
  return {
    id: row.id, orderId: row.orderId, category: row.category, status: row.status,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

const messageDto = (row: SupportMessage) => ({
  id: row.id, author: row.author, text: row.text, createdAt: row.createdAt.toISOString(),
});

export async function listCases(userId: string | undefined, input: PageInput & {
  status?: SupportCase["status"]; category?: SupportCase["category"]; orderId?: string;
}) {
  const { status, category, orderId, limit, cursor } = input;
  const scope = JSON.stringify(["support", userId ?? "staff", status ?? null, category ?? null, orderId ?? null]);
  const rows = await prisma.supportCase.findMany({
    where: { userId, orderId, category, status, ...keysetWhere(scope, cursor) },
    orderBy: newestFirst, take: limit + 1,
  });
  return keysetPage(scope, rows, limit, row => userId ? summary(row) : { ...summary(row), userId: row.userId });
}

export async function readCase(id: string, userId: string | undefined, input: PageInput & { historyCursor?: string }) {
  return prisma.$transaction(async db => {
    const row = await db.supportCase.findFirst({ where: { id, userId } });
    if (!row) throw new AppError(404, "NOT_FOUND");
    const scope = JSON.stringify(["support-messages", userId ?? "staff", id]);
    const historyScope = JSON.stringify(["support-history", userId ?? "staff", id]);
    const messages = await db.supportMessage.findMany({
      where: { caseId: id, ...keysetWhere(scope, input.cursor) },
      orderBy: newestFirst, take: input.limit + 1,
    });
    const history = await db.supportEvent.findMany({
      where: { caseId: id, ...keysetWhere(historyScope, input.historyCursor) },
      orderBy: newestFirst, take: input.limit + 1,
    });
    return {
      case: userId ? summary(row) : { ...summary(row), userId: row.userId },
      messages: keysetPage(scope, messages, input.limit, messageDto),
      history: keysetPage(historyScope, history, input.limit, e => ({
        id: e.id, status: e.toStatus, createdAt: e.createdAt.toISOString(),
        ...(!userId && { reason: e.reason, author: e.author }),
      })),
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function openCase(userId: string, key: string, input: Create) {
  const requestKeyHash = sha256(key);
  const fingerprint = sha256(JSON.stringify([input.category, input.orderId ?? null, input.message]));
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const previous = await db.supportCase.findUnique({ where: { userId_requestKeyHash: { userId, requestKeyHash } } });
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      return { case: summary(previous) };
    }
    if (input.orderId && !await db.order.findFirst({
      where: { id: input.orderId, userId }, select: { id: true },
    })) throw new AppError(404, "NOT_FOUND");

    const row = await db.supportCase.create({
      data: {
        userId, orderId: input.orderId, requestKeyHash, fingerprint, category: input.category,
        messages: { create: { text: input.message, author: "CUSTOMER" } },
        events: { create: { fromStatus: "OPEN", toStatus: "OPEN", author: "CUSTOMER" } },
      },
    });
    return { case: summary(row) };
  });
}

async function lockCase(db: Prisma.TransactionClient, id: string, userId?: string) {
  const [row] = userId
    ? await db.$queryRaw<SupportCase[]>`SELECT * FROM "SupportCase" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`
    : await db.$queryRaw<SupportCase[]>`SELECT * FROM "SupportCase" WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new AppError(404, "NOT_FOUND");
  return row;
}

export async function replyToCase(userId: string, id: string, key: string, text: string) {
  const requestKeyHash = sha256(JSON.stringify(["customer", key]));
  return prisma.$transaction(async db => {
    const row = await lockCase(db, id, userId);
    const previous = await db.supportMessage.findUnique({ where: { caseId_requestKeyHash: { caseId: id, requestKeyHash } } });
    if (previous) {
      if (previous.text !== text) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      return { case: summary(row), message: messageDto(previous) };
    }
    if (row.status === "RESOLVED") throw new AppError(409, "CASE_RESOLVED");
    const now = new Date(Math.max(+await dbNow(db), +row.updatedAt + 1));
    const reply = await db.supportMessage.create({ data: { caseId: id, author: "CUSTOMER", text, requestKeyHash, createdAt: now } });
    if (row.status === "WAITING_CUSTOMER") {
      await db.supportEvent.create({ data: { caseId: id, author: "CUSTOMER", fromStatus: row.status, toStatus: "OPEN", createdAt: now } });
    }
    const updated = await db.supportCase.update({ where: { id }, data: {
      status: "OPEN", updatedAt: now,
    } });
    return { case: summary(updated), message: messageDto(reply) };
  });
}

export async function actOnCase(actorId: string, ip: string, id: string, key: string, input: StaffAction) {
  const requestKeyHash = sha256(JSON.stringify(["staff", actorId, key]));
  const fingerprint = sha256(JSON.stringify([input.status, input.publicReply, input.expectedUpdatedAt, input.reason]));
  return prisma.$transaction(async db => {
    const row = await lockCase(db, id);
    const previous = await db.supportEvent.findUnique({ where: { caseId_requestKeyHash: { caseId: id, requestKeyHash } } });
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      return { case: summary(row), commandId: previous.id };
    }
    if (row.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new AppError(409, "CASE_CHANGED");
    const status = input.status ?? row.status;
    const now = new Date(Math.max(+await dbNow(db), +row.updatedAt + 1));
    if (input.publicReply) {
      await db.supportMessage.create({ data: { caseId: id, author: "STAFF", text: input.publicReply, createdAt: now } });
    }
    const event = await db.supportEvent.create({
      data: { caseId: id, author: "STAFF", fromStatus: row.status, toStatus: status, requestKeyHash, fingerprint, reason: input.reason, createdAt: now },
    });
    const updated = await db.supportCase.update({
      where: { id }, data: { status, updatedAt: now },
    });
    // Keep free-form customer/staff text out of general-purpose audit exports.
    await writeAudit(db, { actorId, action: "support.case.action", entity: "SupportCase", entityId: id, ip,
      data: { commandId: event.id, fromStatus: row.status, toStatus: status, replied: !!input.publicReply } });
    return { case: summary(updated), commandId: event.id };
  });
}
