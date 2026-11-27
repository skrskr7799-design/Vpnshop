import type { UserRole } from "@prisma/client";

const operational = ["dashboard:read", "users:read", "orders:read", "plans:read", "jobs:read", "ops:read", "support:read", "support:reply", "security:self"] as const;
const restricted = [
  "finance:read", "plans:write", "jobs:write", "bindings:write", "access:write", "users:write",
  "finance:reconcile", "finance:refund", "subscription:adjust", "audit:read",
  "settings:write", "support:write",
] as const;
const owner = ["staff:read", "staff:write", "users:create"] as const;
export const PERMISSIONS = [...operational, ...restricted, ...owner] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type AdminRole = Extract<UserRole, "OWNER" | "ADMIN" | "SUPPORT">;

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: [...operational, ...restricted],
  SUPPORT: operational,
};

export const isAdminRole = (role: UserRole): role is AdminRole => role === "OWNER" || role === "ADMIN" || role === "SUPPORT";
export const can = (role: AdminRole, permission: Permission): boolean => ROLE_PERMISSIONS[role].includes(permission);
