import { Prisma, type SupportCase, type SupportMessage } from "@prisma/client";
import { supportChange, supportText, type CaseSummary, type supportCreate } from "@vpn/shared";
import { z } from "zod";
import { requireAdmission } from "../../config/product";
import { emailAvailable, env } from "../../config/env";
import { sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { keysetPage, keysetWhere, newestFirst } from "../../lib/keyset";
import { prisma } from "../../lib/prisma";
import { command, expectVersion, type CommandContext } from "../admin/commands";
import { dbNow } from "../commerce/offers";
import { enqueueMail } from "../mail/outbox";
import { supportUpdateMail } from "../mail/mail.templates";

type Db = Prisma.TransactionClient;
type Reader = { id: string; isStaff: boolean; canReadContact?: boolean };
type PageInput = { limit: number; cursor?: string };
type Create = z.infer<typeof supportCreate>;
type CaseChange = z.infer<typeof supportChange>;
type Status = SupportCase["status"];

const eligibleStaff = {
  role: { in: ["OWNER", "ADMIN", "SUPPORT"] },
  status: "ACTIVE",
  staffCredential: { is: { deactivatedAt: null } },
} satisfies Prisma.UserWhereInput;
const assigneeSelect = { id: true, role: true, status: true, staffCredential: { select: { username: true, deactivatedAt: true } } } as const;
const staffCaseInclude = {
  assignee: { select: assigneeSelect },
  user: { select: { email: true, emailVerifiedAt: true, identities: {
    where: { provider: { in: ["TELEGRAM", "GOOGLE"] } }, select: { provider: true, providerId: true },
  } } },
} satisfies Prisma.SupportCaseInclude;
type StaffCase = Prisma.SupportCaseGetPayload<{ include: typeof staffCaseInclude }>;

function summary(row: SupportCase): CaseSummary {
  return {
    id: row.id, orderId: row.orderId, category: row.category, status: row.status, subject: row.subject,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function hasAssignee(row: SupportCase | StaffCase): row is StaffCase {
  return "assignee" in row;
}

function staffSummary(row: StaffCase, reader: Reader) {
  const { email, emailVerifiedAt, identities } = row.user;
  const telegram = identities.find(identity => identity.provider === "TELEGRAM");
  const emailLabel = email && emailVerifiedAt &&
    (reader.canReadContact ? email : email.slice(0, 1) + "•••@" + email.split("@").at(-1));
  const telegramLabel = telegram && (reader.canReadContact ? telegram.providerId : "•••" + (telegram.providerId.length > 4 ? telegram.providerId.slice(-4) : ""));
  const customer = [
    ...(emailLabel ? ["Email · " + emailLabel] : []),
    ...(telegramLabel ? ["Telegram · " + telegramLabel] : []),
    ...(identities.some(identity => identity.provider === "GOOGLE") ? ["Google подключён"] : []),
  ];
  const assignee = row.assignee;
  const active = assignee && assignee.role !== "USER" && assignee.status === "ACTIVE" &&
    assignee.staffCredential && !assignee.staffCredential.deactivatedAt;
  return {
    ...summary(row), userId: row.userId, priority: row.priority, customer: customer[0] ?? null, customerIdentities: customer,
    assigneeId: active ? assignee.id : null, assignee: active ? assignee.staffCredential!.username : null,
  };
}

function messageDto(row: SupportMessage, staff = false) {
  return {
    id: row.id, author: row.author, text: row.text, createdAt: row.createdAt.toISOString(),
    ...(staff && { actorId: row.actorId }),
  };
}

function eventAudience(reader: Reader) {
  return reader.isStaff ? Prisma.sql`e.author = 'CUSTOMER'` : Prisma.sql`e.author = 'STAFF' AND e."customerVisible"`;
}

async function unreadCounts(db: Db, ids: string[], reader: Reader) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db.$queryRaw<{ caseId: string; unread: number }[]>`
    SELECT e."caseId", count(*)::int AS unread
    FROM "SupportEvent" e LEFT JOIN "SupportReadCursor" r
      ON r."caseId" = e."caseId" AND r."readerId" = ${reader.id}
    WHERE e."caseId" IN (${Prisma.join(ids)}) AND ${eventAudience(reader)}
      AND (r."seenAt" IS NULL OR e."createdAt" > r."seenAt")
    GROUP BY e."caseId"`;
  return new Map(rows.map(row => [row.caseId, row.unread]));
}

export async function listCases(reader: Reader, input: PageInput & {
  status?: Status; category?: SupportCase["category"]; orderId?: string; forUserId?: string;
  priority?: SupportCase["priority"]; assigneeId?: string; search?: string;
}) {
  const { status, category, orderId, forUserId, limit, cursor, priority, assigneeId, search } = input;
  const userId = reader.isStaff ? forUserId : reader.id;
  const scope = JSON.stringify(["support", reader.id, reader.isStaff, status, category, orderId, userId, priority, assigneeId, search]);
  const uuid = search && z.uuid().safeParse(search).success ? search : undefined;
  const conditions: Prisma.SupportCaseWhereInput[] = [];
  if (search) conditions.push({ OR: [
    { subject: { contains: search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"), mode: "insensitive" } },
    ...(uuid ? [{ id: uuid }, { userId: uuid }, { orderId: uuid }] : []),
  ] });
  if (assigneeId === "unassigned") conditions.push({ OR: [{ assigneeId: null }, { assignee: { isNot: eligibleStaff } }] });
  else if (assigneeId) conditions.push({ assigneeId, assignee: { is: eligibleStaff } });

  return prisma.$transaction(async db => {
    const args = { where: { userId, orderId, category, status, priority, AND: conditions, ...keysetWhere(scope, cursor) },
      orderBy: newestFirst, take: limit + 1 };
    const rows: (SupportCase | StaffCase)[] = reader.isStaff
      ? await db.supportCase.findMany({ ...args, include: staffCaseInclude })
      : await db.supportCase.findMany(args);
    const unread = await unreadCounts(db, rows.map(row => row.id), reader);
    return keysetPage(scope, rows, limit, row => ({
      ...(hasAssignee(row) ? staffSummary(row, reader) : summary(row)), unread: unread.get(row.id) ?? 0,
    }));
  }, { isolationLevel: "RepeatableRead" });
}

export async function listAssignees() {
  const staff = await prisma.user.findMany({ where: eligibleStaff, select: { id: true, staffCredential: { select: { username: true } } },
    orderBy: { staffCredential: { username: "asc" } }, take: 200 });
  return { items: staff.map(row => ({ id: row.id, username: row.staffCredential!.username })) };
}

export async function readCase(id: string, reader: Reader, input: PageInput & { historyCursor?: string }) {
  return prisma.$transaction(async db => {
    const row: SupportCase | StaffCase | null = reader.isStaff
      ? await db.supportCase.findUnique({ where: { id }, include: staffCaseInclude })
      : await db.supportCase.findFirst({ where: { id, userId: reader.id } });
    if (!row) throw new AppError(404, "NOT_FOUND");
    const scope = JSON.stringify(["support-messages", reader.id, id]);
    const historyScope = JSON.stringify(["support-history", reader.id, id]);
    const messages = await db.supportMessage.findMany({
      where: { caseId: id, ...keysetWhere(scope, input.cursor) },
      orderBy: newestFirst, take: input.limit + 1,
    });
    const history = await db.supportEvent.findMany({
      where: { caseId: id, customerVisible: reader.isStaff ? undefined : true, ...keysetWhere(historyScope, input.historyCursor) },
      orderBy: newestFirst, take: input.limit + 1,
    });
    const unread = await unreadCounts(db, [id], reader);
    return {
      case: { ...(hasAssignee(row) ? staffSummary(row, reader) : summary(row)), unread: unread.get(id) ?? 0 },
      ...(!input.cursor && !input.historyCursor && { readThrough: row.updatedAt.toISOString() }),
      messages: keysetPage(scope, messages, input.limit, message => messageDto(message, reader.isStaff)),
      history: keysetPage(historyScope, history, input.limit, e => ({
        id: e.id, status: e.toStatus, createdAt: e.createdAt.toISOString(),
        ...(reader.isStaff && { reason: e.reason, author: e.author }),
      })),
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function openCase(userId: string, key: string, input: Create) {
  const requestKeyHash = sha256(key);
  const fingerprint = sha256(JSON.stringify([input.category, input.orderId ?? null, input.message, ...(input.subject ? [input.subject] : [])]));
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

    const now = await dbNow(db);
    requireAdmission(env, "support");
    const row = await db.supportCase.create({
      data: {
        userId, orderId: input.orderId, requestKeyHash, fingerprint, category: input.category, subject: input.subject, createdAt: now, updatedAt: now,
        messages: { create: { text: input.message, author: "CUSTOMER", actorId: userId, createdAt: now } },
        events: { create: { fromStatus: "OPEN", toStatus: "OPEN", author: "CUSTOMER", createdAt: now } },
      },
    });
    return { case: summary(row) };
  });
}

async function lockCase(db: Db, id: string, userId?: string) {
  const [row] = userId
    ? await db.$queryRaw<SupportCase[]>`SELECT * FROM "SupportCase" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`
    : await db.$queryRaw<SupportCase[]>`SELECT * FROM "SupportCase" WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new AppError(404, "NOT_FOUND");
  return row;
}

export async function markCaseRead(reader: Reader, id: string, through: Date) {
  await prisma.$transaction(async db => {
    const row = await lockCase(db, id, reader.isStaff ? undefined : reader.id);
    if (through > row.updatedAt) throw new AppError(400, "INVALID_READ_CURSOR");
    await db.$executeRaw`
      INSERT INTO "SupportReadCursor" ("caseId", "readerId", "seenAt") VALUES (${id}, ${reader.id}, ${through})
      ON CONFLICT ("caseId", "readerId") DO UPDATE SET "seenAt" = greatest("SupportReadCursor"."seenAt", excluded."seenAt")`;
  });
}

async function nextTime(db: Db, row: SupportCase) {
  return new Date(Math.max(+await dbNow(db), +row.updatedAt + 1));
}

const finished = (status: Status) => status === "CLOSED" || status === "RESOLVED";

export async function replyToCase(userId: string, id: string, key: string, text: string) {
  const requestKeyHash = sha256(JSON.stringify(["customer", key]));
  return prisma.$transaction(async db => {
    const row = await lockCase(db, id, userId);
    const previous = await db.supportMessage.findUnique({ where: { caseId_requestKeyHash: { caseId: id, requestKeyHash } } });
    if (previous) {
      if (previous.text !== text) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      return { case: summary(row), message: messageDto(previous) };
    }
    if (finished(row.status)) throw new AppError(409, "CASE_RESOLVED");
    const now = await nextTime(db, row);
    const reply = await db.supportMessage.create({ data: { caseId: id, author: "CUSTOMER", actorId: userId, text, requestKeyHash, createdAt: now } });
    await db.supportEvent.create({ data: { caseId: id, author: "CUSTOMER", fromStatus: row.status, toStatus: "OPEN", createdAt: now } });
    const updated = await db.supportCase.update({ where: { id }, data: { status: "OPEN", updatedAt: now } });
    return { case: summary(updated), message: messageDto(reply) };
  });
}

const transitions: Record<Status, readonly Status[]> = {
  OPEN: ["IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"],
  WAITING_CUSTOMER: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: [],
};

function requireTransition(from: Status, to: Status) {
  if (from !== to && !transitions[from].includes(to)) throw new AppError(409, "CASE_STATUS_CONFLICT");
}

export async function changeCustomerCase(userId: string, id: string, key: string, action: "close" | "reopen") {
  const requestKeyHash = sha256(JSON.stringify(["customer-status", key]));
  return prisma.$transaction(async db => {
    const row = await lockCase(db, id, userId);
    const previous = await db.supportEvent.findUnique({ where: { caseId_requestKeyHash: { caseId: id, requestKeyHash } } });
    if (previous) {
      if (previous.fingerprint !== action) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      return { case: summary(row) };
    }
    const status = action === "close" ? "CLOSED" : "OPEN";
    if (action === "reopen" && row.status !== "RESOLVED") throw new AppError(409, "CASE_STATUS_CONFLICT");
    requireTransition(row.status, status);
    if (row.status === status) return { case: summary(row) };
    const now = await nextTime(db, row);
    await db.supportEvent.create({ data: {
      caseId: id, author: "CUSTOMER", fromStatus: row.status, toStatus: status, requestKeyHash, fingerprint: action, createdAt: now,
    } });
    return { case: summary(await db.supportCase.update({ where: { id }, data: { status, updatedAt: now } })) };
  });
}

async function applyStaffChange(ctx: CommandContext, input: CaseChange) {
  const id = z.uuid().parse(ctx.targetId);
  const row = await lockCase(ctx.db, id);
  expectVersion(ctx.expectedVersion, row.updatedAt);
  const status = input.status ?? (input.publicReply ? "WAITING_CUSTOMER" : row.status);
  requireTransition(row.status, status);
  if (input.publicReply && (row.status === "CLOSED" || row.status === "RESOLVED" && status !== "OPEN"))
    throw new AppError(409, "CASE_RESOLVED");
  if (input.assigneeId && !await ctx.db.user.findFirst({ where: { id: input.assigneeId, ...eligibleStaff }, select: { id: true } }))
    throw new AppError(409, "INVALID_ASSIGNEE");

  const now = await nextTime(ctx.db, row);
  if (input.publicReply) await ctx.db.supportMessage.create({ data: {
    caseId: id, author: "STAFF", actorId: ctx.actor.userId, text: input.publicReply, createdAt: now,
  } });
  const customerVisible = !!input.publicReply || row.status !== status;
  await ctx.db.supportEvent.create({ data: {
    caseId: id, author: "STAFF", fromStatus: row.status, toStatus: status, reason: ctx.reason, customerVisible, createdAt: now,
  } });
  if (customerVisible && emailAvailable) {
    const owner = await ctx.db.user.findFirst({ where: { id: row.userId, status: "ACTIVE", role: "USER", emailVerifiedAt: { not: null } },
      select: { email: true } });
    if (owner?.email) await enqueueMail(ctx.db, supportUpdateMail(owner.email, id), new Date(+now + 86_400_000));
  }
  const updated = await ctx.db.supportCase.update({ where: { id }, data: {
    status, updatedAt: now, priority: input.priority, assigneeId: input.assigneeId,
  } });
  const { subject: _privateSubject, ...caseState } = summary(updated);
  return { case: caseState, before: row.status, after: status, replied: !!input.publicReply,
    previousPriority: row.priority, priority: updated.priority, previousAssigneeId: row.assigneeId, assigneeId: updated.assigneeId };
}

export const supportCommands = {
  "support.action": command("support:write", supportChange, applyStaffChange),
  "support.reply": command("support:reply", z.strictObject({ publicReply: supportText }), applyStaffChange),
};
