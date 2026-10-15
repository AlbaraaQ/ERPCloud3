/**
 * Request-scoped platform identity + guards (PLATFORM_ADMIN §2/§6, D-020).
 *
 * The console has its own session namespace (cookie + `sessions.platform_user_id`)
 * and its own permissions. A platform session carries NO tenant binding, so the
 * tenant services (which require `requireTenant`) are unreachable from it — that
 * is the first half of "the console is not a backdoor into tenant books".
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { db } from "@/db";
import { platformUsers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildSessionByToken, PLATFORM_SESSION_COOKIE } from "./session";
import { errors } from "@/modules/shared/result";
import { platformPermissionsFor } from "./permissions";

export interface PlatformContext {
  sessionId: string;
  platformUserId: string;
  name: string;
  email: string;
  role: "owner" | "ops";
  permissions: ReadonlySet<string>;
  expiresAt: Date;
}

/** Build the context from a raw token (testable core — no cookies involved). */
export async function buildPlatformContext(token: string): Promise<PlatformContext | null> {
  const session = await buildSessionByToken(token);
  if (!session) return null;
  const [user] = await db
    .select()
    .from(platformUsers)
    .where(eq(platformUsers.id, session.platformUserId))
    .limit(1);
  if (!user || user.status !== "active") return null;
  return {
    sessionId: session.sessionId,
    platformUserId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: platformPermissionsFor(user.role),
    expiresAt: session.expiresAt,
  };
}

/** Per-request memoized platform context. */
export const getPlatformContext = cache(async (): Promise<PlatformContext | null> => {
  const store = await cookies();
  const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
  if (!token) return null;
  return buildPlatformContext(token);
});

export function hasPlatformPermission(ctx: PlatformContext, code: string): boolean {
  return ctx.permissions.has(code);
}

/** Throw PermissionDenied when the platform permission is missing. */
export function requirePlatformPermission(ctx: PlatformContext | null, code: string): PlatformContext {
  if (!ctx) throw errors.auth("errors.sessionInvalid");
  if (!ctx.permissions.has(code)) throw errors.permission(code);
  return ctx;
}

/** Require any valid platform session. */
export function requirePlatform(ctx: PlatformContext | null): PlatformContext {
  if (!ctx) throw errors.auth("errors.sessionInvalid");
  return ctx;
}

/** Owner-only operations (destructive workflows, restore, deletion). */
export function requirePlatformOwner(ctx: PlatformContext | null): PlatformContext {
  const c = requirePlatform(ctx);
  if (c.role !== "owner") throw errors.permission("platform.owner.only");
  return c;
}

/** Display label used in audit rows. */
export function platformActorLabel(ctx: PlatformContext): string {
  return `${ctx.name} <${ctx.email}> [platform:${ctx.role}]`;
}
