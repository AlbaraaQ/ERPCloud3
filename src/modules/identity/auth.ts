/**
 * Authentication & session context (D-010, SEC §3).
 * - Argon2id password hashing
 * - Server-side session rows; cookie holds only the raw token (sha256 stored)
 * - SessionContext resolution with tenant binding + permission set
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { generateSessionToken, hashToken, tokensEqual } from "./tokens";
import { SESSION_COOKIE } from "./constants";
import * as argon2 from "argon2";
import type { HashOptions } from "argon2";
import { db } from "@/db";
import { sessions, users, roles, userRoles, rolePermissions, tenants } from "@/db/schema";
import { and, eq, isNull, gt } from "drizzle-orm";
import { withTenant } from "@/modules/shared/db-context";
import { logger } from "@/modules/shared/logger";
import type { SessionContext, TenantInfo } from "@/modules/shared/context";

export { SESSION_COOKIE } from "./constants";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h idle expiry (ERP default)

/* ------------------------------------------------------------------ passwords */
const ARGON2_OPTS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 3,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (e) {
    logger.warn({ err: e }, "argon2 verify failed (malformed hash?)");
    return false;
  }
}

/* ------------------------------------------------------------------- sessions */
// Token primitives live in ./tokens (Node-only, reusable by the platform tier).
export { generateSessionToken, hashToken, tokensEqual };

export interface CreateSessionArgs {
  userId?: string | null;
  platformUserId?: string | null;
  tenantId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(args: CreateSessionArgs): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId: args.userId ?? null,
    platformUserId: args.platformUserId ?? null,
    tenantId: args.tenantId ?? null,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
    expiresAt,
    lastSeenAt: new Date(),
  });
  return { token, expiresAt };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Load full session context from a raw cookie token (testable core). */
export async function buildContextByToken(token: string): Promise<SessionContext | null> {
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);

  if (!row) return null;

  // Sliding expiry touch — at most once per 5 minutes to avoid write amplification
  if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 5 * 60 * 1000) {
    db.update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.id, row.id))
      .execute()
      .catch((e) => logger.warn({ err: e }, "session touch failed"));
  }

  // A platform session is NOT a tenant session: the console resolves it through
  // `buildPlatformContext`, so this resolver refuses it outright (session isolation,
  // PLATFORM_ADMIN §6.5). One sessions table, two disjoint resolvers.
  if (row.platformUserId || !row.userId || !row.tenantId) return null;

  const base = {
    session: { id: row.id, expiresAt: row.expiresAt, ip: row.ip, userAgent: row.userAgent },
    userId: row.userId,
    platformUserId: null,
  };

  return withTenant(row.tenantId, async (trx) => {
    const [user] = await trx
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        tenantId: users.tenantId,
      })
      .from(users)
      .where(eq(users.id, row.userId!))
      .limit(1);
    if (!user || user.status !== "active") return null;

    const [tenant] = await trx
      .select({ id: tenants.id, name: tenants.name, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId!))
      .limit(1);
    if (!tenant) return null;

    const permRows = await trx
      .select({ code: rolePermissions.permissionCode, roleKey: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(eq(userRoles.userId, user.id));

    const roleRows = await trx
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, user.id));

    return {
      ...base,
      userName: user.name,
      userEmail: user.email,
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status as TenantInfo["status"] },
      roles: roleRows.map((r) => r.key),
      permissions: new Set(permRows.map((p) => p.code)),
    };
  });
}

/* ------------------------------------------------------- request-scoped access */
/** Per-request memoized session context (React cache dedupes within one render). */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return buildContextByToken(token);
});

