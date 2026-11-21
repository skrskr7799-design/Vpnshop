import type { Prisma } from "@prisma/client";

export type AuditEntry = {
  actorId: string | null;
  action: string; // "plan.update", "admin.login" ...
  entity: string;
  entityId?: string;
  data?: Prisma.InputJsonValue;
  ip?: string;
};

// Пишем журнал в той же транзакции, что и само изменение: нет действия без записи и записи без действия.
export async function writeAudit(db: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      data: entry.data,
      ip: entry.ip,
    },
  });
}
