import { emailField, staffUsernameSchema } from "@vpn/shared";
import { z } from "zod";
import { isUniqueViolation } from "../../../lib/db-errors";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { hashPassword } from "../../auth/password";
import { lockIdentityOwner } from "../../auth/session.service";
import { dbNow } from "../../commerce/offers";
import { writeAudit } from "../admin.audit";
import { createStaffAccount, invalidateStaff, lockStaffWrites } from "./admin-auth.service";

const password = z.string().min(12).max(128);
const incident = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{4,79}$/);
const username = staffUsernameSchema;
export const bootstrapInput = z.strictObject({ username, password, correlationId: z.uuid(),
  displayName: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u).optional(), contactEmail: emailField.optional() });
export const recoverInput = z.strictObject({ username, password, incident, correlationId: z.uuid(),
  resetTotp: z.boolean(), restoreStatus: z.boolean() });
export const adoptInput = z.strictObject({ username, incident, correlationId: z.uuid() });

export async function bootstrapOwner(input: z.infer<typeof bootstrapInput>) {
  const { password, correlationId, ...profile } = bootstrapInput.parse(input);
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async db => {
    await lockStaffWrites(db);
    if (await db.user.count({ where: { role: { in: ["OWNER", "ADMIN", "SUPPORT"] } } }) || await db.staffCredential.count())
      throw new AppError(409, "STAFF_ALREADY_INITIALIZED");
    try {
      const owner = await createStaffAccount(db, { ...profile, passwordHash, role: "OWNER" });
      await writeAudit(db, { actorId: null, action: "admin.owner.bootstrap", entity: "staff", entityId: owner.id,
        correlationId, data: { username: profile.username }, outcome: "SUCCEEDED" });
      return { id: owner.id, username: profile.username, role: owner.role };
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "STAFF_USERNAME_IN_USE");
      throw error;
    }
  });
}

export async function recoverOwner(input: z.infer<typeof recoverInput>) {
  const { username, password, incident, correlationId, resetTotp, restoreStatus } = recoverInput.parse(input);
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async db => {
    await lockStaffWrites(db);
    const credential = await db.staffCredential.findUnique({ where: { username } });
    const owner = credential && await lockIdentityOwner(db, credential.userId);
    if (!credential || !owner || owner.role !== "OWNER" || credential.deactivatedAt) throw new AppError(404, "OWNER_NOT_FOUND");
    const now = await dbNow(db);
    await invalidateStaff(db, owner.id, now, resetTotp);
    await db.staffCredential.update({ where: { userId: owner.id }, data: { passwordHash, temporaryUntil: null } });
    if (restoreStatus) await db.user.update({ where: { id: owner.id }, data: { status: "ACTIVE" } });
    await writeAudit(db, { actorId: null, action: "admin.owner.recover", entity: "staff", entityId: owner.id, correlationId,
      reason: incident, outcome: "SUCCEEDED", data: { resetTotp, restoreStatus } });
    return { id: owner.id, username, active: restoreStatus || owner.status === "ACTIVE" };
  });
}

export async function adoptLegacyOwner(input: z.infer<typeof adoptInput>) {
  const { username, incident, correlationId } = adoptInput.parse(input);
  return prisma.$transaction(async db => {
    await lockStaffWrites(db);
    if (await db.user.count({ where: { role: "OWNER" } })) throw new AppError(409, "OWNER_ALREADY_EXISTS");
    const credential = await db.staffCredential.findUnique({ where: { username } });
    const staff = credential && await lockIdentityOwner(db, credential.userId);
    if (!credential || !staff || staff.role !== "ADMIN" || staff.status !== "ACTIVE" || credential.temporaryUntil || credential.deactivatedAt)
      throw new AppError(409, "LEGACY_ADMIN_NOT_ELIGIBLE");
    await db.user.update({ where: { id: staff.id }, data: { role: "OWNER" } });
    await invalidateStaff(db, staff.id, await dbNow(db));
    await writeAudit(db, { actorId: null, action: "admin.owner.adopt_legacy", entity: "staff", entityId: staff.id, correlationId,
      reason: incident, outcome: "SUCCEEDED", data: { before: "ADMIN", after: "OWNER" } });
    return { id: staff.id, username, role: "OWNER" };
  });
}

export async function listLocalStaff() {
  const rows = await prisma.staffCredential.findMany({ orderBy: { username: "asc" }, select: {
    username: true, contactEmail: true, user: { select: { id: true, role: true, status: true } },
  } });
  return rows.map(({ user, ...profile }) => ({ ...user, ...profile }));
}
