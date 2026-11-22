import type { UserRole } from "@prisma/client";

export const PERMISSIONS = [
  "dashboard:read",
  "users:read",
  "users:write",
  "orders:read",
  "orders:write",
  "plans:read",
  "plans:write",
  "jobs:read",
  "jobs:write",
  "audit:read",
  "support:read",
  "support:write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type AdminRole = Extract<UserRole, "ADMIN" | "SUPPORT">;

// ADMIN может всё. SUPPORT отвечает по обращениям и читает разрешённые операционные данные.
export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  SUPPORT: ["dashboard:read", "users:read", "orders:read", "plans:read", "jobs:read", "support:read", "support:write"],
};

export const isAdminRole = (role: UserRole): role is AdminRole => role === "ADMIN" || role === "SUPPORT";
export const can = (role: AdminRole, permission: Permission): boolean => ROLE_PERMISSIONS[role].includes(permission);
