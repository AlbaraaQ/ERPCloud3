/**
 * Platform-tier authorization (PLATFORM_ADMIN.md §1, §6).
 *
 * The console is a separate interface with its own user store, roles and session
 * namespace. Roles map to a fixed permission set — there is no tenant role that
 * grants platform access, and no platform permission that implies tenant data
 * access: reading tenant books needs a valid, approved, unexpired support grant.
 */

export const PLATFORM_PERMISSIONS = [
  "platform.tenants.view",
  "platform.tenants.manage",
  "platform.plans.manage",
  "platform.flags.manage",
  "platform.ops.view",
  "platform.alerts.manage",
  "platform.backup.run",
  "platform.backup.verify",
  "platform.backup.restore",
  "platform.grants.request",
  "platform.grants.approve",
  "platform.grants.revoke",
  "platform.audit.view",
  "platform.exports.manage",
  "platform.data.delete",
  "platform.settings.manage",
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** Owner: everything, including destructive workflows. Ops: operate, never destroy. */
const ROLE_PERMISSIONS: Record<string, PlatformPermission[]> = {
  owner: [...PLATFORM_PERMISSIONS],
  ops: [
    "platform.tenants.view",
    "platform.tenants.manage",
    "platform.ops.view",
    "platform.alerts.manage",
    "platform.backup.run",
    "platform.backup.verify",
    "platform.grants.request",
    "platform.grants.revoke",
    "platform.audit.view",
    "platform.exports.manage",
  ],
};

export function platformPermissionsFor(role: string): ReadonlySet<string> {
  return new Set(ROLE_PERMISSIONS[role] ?? []);
}

/** Support-grant scope: what a break-glass session may actually look at. */
export interface SupportScope {
  screens?: string[];
  amounts?: boolean;
  exports?: boolean;
}

/** Screens a grant can be issued for (allow-list — anything else is not grantable). */
export const GRANTABLE_SCREENS = [
  "dashboard",
  "sales",
  "purchasing",
  "inventory",
  "accounting",
  "settlement",
  "tax",
  "reports",
  /**
   * Not a screen: the whole-tenant export bundle. Producing one is a read of the
   * entire tenant, so it needs its own entry in the grant scope and the explicit
   * `exports: true` flag.
   */
  "export",
] as const;
