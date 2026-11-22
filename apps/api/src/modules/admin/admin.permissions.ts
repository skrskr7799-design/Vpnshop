import type { UserRole } from "@prisma/client";

const operational = ["dashboard:read", "users:read", "orders:read", "plans:read", "jobs:read", "ops:read", "support:read"] as const;
const restricted = [
  "finance:read", "plans:write", "jobs:write", "bindings:write", "access:write", "users:write",
  "finance:reconcile", "finance:refund", "subscription:adjust", "audit:read", "staff:read",
  "staff:write", "settings:write", "support:write",
] as const;
export const PERMISSIONS = [...operational, ...restricted] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type AdminRole = Extract<UserRole, "ADMIN" | "SUPPORT">;

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  SUPPORT: operational,
};

export const isAdminRole = (role: UserRole): role is AdminRole => role === "ADMIN" || role === "SUPPORT";
export const can = (role: AdminRole, permission: Permission): boolean => ROLE_PERMISSIONS[role].includes(permission);
