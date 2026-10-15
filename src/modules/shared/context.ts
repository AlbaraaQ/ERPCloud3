/**
 * Request-scoped identity context + server-side guards (D-010, SEC §4).
 * UI hiding is never a control: every service entry point calls the guards here.
 */

import { errors } from "./result";

export interface TenantInfo {
  id: string;
  name: string;
  status: "trial" | "active" | "suspended" | "deactivated";
}

export interface SessionInfo {
  id: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionContext {
  session: SessionInfo;
  /** Tenant user id (null for platform-only sessions). */
  userId: string | null;
  platformUserId: string | null;
  userName: string;
  userEmail: string;
  tenant: TenantInfo | null;
  roles: string[];
  permissions: ReadonlySet<string>;
}

/** Minimal context for core engine services (posting/stock) — permission
 *  checks happen in the action layer; engines trust the tenant binding. */
export interface ServiceCtx {
  tenantId: string;
  actorId: string | null;
}

export const serviceCtxOf = (ctx: SessionContext & { tenant: { id: string } | null }): ServiceCtx => ({
  tenantId: ctx.tenant!.id,
  actorId: ctx.userId,
});

export function hasPermission(ctx: SessionContext, code: string): boolean {
  return ctx.permissions.has(code);
}

/** Throw PermissionDenied when the permission is missing (server-side control). */
export function requirePermission(ctx: SessionContext, code: string): void {
  if (!hasPermission(ctx, code)) throw errors.permission(code);
}

/** Require a tenant-bound session (all ERP operations). */
export function requireTenant(ctx: SessionContext): TenantInfo {
  if (!ctx.tenant || !ctx.userId) {
    throw errors.auth("errors.sessionInvalid");
  }
  return ctx.tenant;
}

/** Require the tenant be in an operable state. */
export function requireOperableTenant(ctx: SessionContext): TenantInfo {
  const t = requireTenant(ctx);
  if (t.status === "suspended") throw errors.validation("errors.tenantSuspended");
  if (t.status === "deactivated") throw errors.validation("errors.tenantDeactivated");
  return t;
}
