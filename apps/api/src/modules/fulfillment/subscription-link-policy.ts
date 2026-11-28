import type { Prisma } from "@prisma/client";

export async function subscriptionLinkAllowed(db: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { subscriptionLinkPolicy: true } });
  if (!user) return false;
  if (user.subscriptionLinkPolicy !== "INHERIT") return user.subscriptionLinkPolicy === "ALLOW";
  const settings = await db.adminOperationalSettings.findUnique({
    where: { id: "default" }, select: { subscriptionLinkAllowed: true },
  });
  return settings?.subscriptionLinkAllowed ?? true;
}
