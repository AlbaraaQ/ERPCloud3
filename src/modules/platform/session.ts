/**
 * Platform session namespace (PLATFORM_ADMIN §6.5).
 *
 * A separate cookie (`hisab_platform_session`) and its own lookup: a tenant
 * cookie can never satisfy a platform request and vice versa, because each
 * lookup requires the matching user column (`user_id` vs `platform_user_id`).
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { hashToken } from "@/modules/identity/tokens";
export const PLATFORM_SESSION_COOKIE = "hisab_platform_session";
/**
 * Signed, short-lived token that carries a successful password check into the 2FA
 * step. It lives here rather than in `actions.ts` because a `"use server"` module
 * may only export async functions — a constant exported from it fails at runtime
 * when a page imports it.
 */
export const TOTP_PENDING_COOKIE = "hisab_platform_2fa";
export const PLATFORM_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // shorter than tenant sessions

export interface PlatformSessionRef {
  sessionId: string;
  platformUserId: string;
  expiresAt: Date;
}

/** Look up a live platform session by raw token. Tenant sessions never match. */
export async function buildSessionByToken(token: string): Promise<PlatformSessionRef | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row || !row.platformUserId || row.userId) return null;
  return { sessionId: row.id, platformUserId: row.platformUserId, expiresAt: row.expiresAt };
}
