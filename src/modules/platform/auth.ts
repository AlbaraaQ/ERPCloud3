/**
 * Platform authentication (PLATFORM_ADMIN §0/§2, D-020).
 *
 * - separate credential store (`platform_users`) and session namespace;
 * - throttling per email and per IP + account lockout after repeated failures;
 * - mandatory TOTP for the Owner role: an owner who has not enrolled yet is
 *   sent through enrolment and cannot complete a login until a code verifies;
 * - the TOTP secret is generated, verified against a signed *pending* token,
 *   and only then stored — encrypted (D-024). An unverified secret never lands
 *   in the database.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import argon2 from "argon2";
import type { HashOptions } from "argon2";
import { db } from "@/db";
import { platformUsers } from "@/db/schema";
import { createSession, revokeSession } from "@/modules/identity/auth";
import { appKey, decryptToString, encryptSecret } from "@/modules/shared/crypto";
import { logger } from "@/modules/shared/logger";
import { takeToken } from "./rate-limit";
import { writePlatformAudit } from "./audit";
import { currentTotp, generateTotpSecret, totpUri, verifyTotp } from "./totp";

const ARGON2_OPTS: HashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 };
export const PLATFORM_MAX_FAILED = 5;
export const PLATFORM_LOCK_MINUTES = 15;
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PlatformLoginInput {
  email: string;
  password: string;
  totp?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type PlatformLoginResult =
  | { ok: true; token: string; expiresAt: Date; name: string; role: "owner" | "ops" }
  | { ok: false; errorKey: string; needTotp?: boolean; needEnrollment?: boolean; pendingToken?: string };

let dummyHashPromise: Promise<string> | null = null;
const dummyHash = () =>
  (dummyHashPromise ??= argon2.hash("hisab-platform-dummy", ARGON2_OPTS));

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (e) {
    logger.warn({ err: e }, "platform argon2 verify failed");
    return false;
  }
}

/* ------------------------------------------------ signed one-time pending tokens */
/** HMAC-signed, short-lived, purpose-bound token — no server state required. */
export function signPending(platformUserId: string, purpose: string, payload = ""): string {
  const exp = Date.now() + PENDING_TTL_MS;
  const body = `${platformUserId}.${purpose}.${exp}`;
  const data = `${body}.${payload}`;
  const sig = createHmac("sha256", appKey()).update(data).digest("base64url");
  return `${Buffer.from(data, "utf8").toString("base64url")}.${sig}`;
}

export function readPending(
  token: string,
  purpose: string,
): { platformUserId: string; payload: string } | null {
  try {
    const [encoded, sig] = token.split(".");
    if (!encoded || !sig) return null;
    const data = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = createHmac("sha256", appKey()).update(data).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const [platformUserId, tokenPurpose, exp, ...rest] = data.split(".");
    if (tokenPurpose !== purpose) return null;
    if (!platformUserId || !exp || Number(exp) < Date.now()) return null;
    return { platformUserId, payload: rest.join(".") };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- login */

export async function platformLogin(input: PlatformLoginInput): Promise<PlatformLoginResult> {
  const email = input.email.trim().toLowerCase();
  const auditBase = {
    actorLabel: email,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };

  // 1. throttle (per email and per IP) — breaches raise an alert, never silent
  const byEmail = await takeToken("platform-login", email);
  const byIp = await takeToken("platform-login-ip", input.ip ?? "unknown");
  if (!byEmail.allowed || !byIp.allowed) {
    await writePlatformAudit(db, { ...auditBase, action: "platform.login.throttled", entity: "platform_user", entityId: email });
    return { ok: false, errorKey: "errors.platformThrottled" };
  }

  // 2. lookup (SECURITY DEFINER — platform_users has no RLS by design)
  const lookup = (await db.execute(sql`select * from public.platform_login_lookup(${email})`)) as unknown as {
    rows: { platform_user_id: string; password_hash: string; name: string; role: string; status: string }[];
  };
  const found = lookup.rows[0];
  const hash = found ? found.password_hash : await dummyHash();
  const passwordOk = await verifyPassword(hash, input.password);

  if (!found || !passwordOk) {
    if (found) await registerFailure(found.platform_user_id);
    await writePlatformAudit(db, {
      ...auditBase,
      action: "platform.login.failed",
      entity: "platform_user",
      entityId: found?.platform_user_id ?? null,
    });
    return { ok: false, errorKey: "errors.invalidCredentials" };
  }
  if (found.status !== "active") {
    await writePlatformAudit(db, {
      ...auditBase,
      actorPlatformUserId: found.platform_user_id,
      action: "platform.login.blocked_disabled",
      entity: "platform_user",
      entityId: found.platform_user_id,
    });
    return { ok: false, errorKey: "errors.accountDisabled" };
  }

  const [row] = await db
    .select()
    .from(platformUsers)
    .where(eq(platformUsers.id, found.platform_user_id))
    .limit(1);
  if (!row) return { ok: false, errorKey: "errors.invalidCredentials" };

  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60000);
    await writePlatformAudit(db, {
      ...auditBase,
      actorPlatformUserId: row.id,
      action: "platform.login.locked",
      entity: "platform_user",
      entityId: row.id,
      after: { minutes },
    });
    return { ok: false, errorKey: "errors.platformLocked" };
  }

  // 3. 2FA — mandatory for Owner
  if (row.role === "owner") {
    if (!row.totpSecretCipher) {
      await writePlatformAudit(db, {
        ...auditBase,
        actorPlatformUserId: row.id,
        action: "platform.2fa.enrollment_required",
        entity: "platform_user",
        entityId: row.id,
      });
      return { ok: false, errorKey: "errors.platformTotpEnrollRequired", needEnrollment: true, pendingToken: signPending(row.id, "2fa-enroll") };
    }
    const code = (input.totp ?? "").trim();
    if (!code) {
      await writePlatformAudit(db, {
        ...auditBase,
        actorPlatformUserId: row.id,
        action: "platform.login.totp_required",
        entity: "platform_user",
        entityId: row.id,
      });
      return { ok: false, errorKey: "errors.platformTotpRequired", needTotp: true };
    }
    const secret = decryptToString(row.totpSecretCipher);
    if (!verifyTotp(secret, code)) {
      await registerFailure(row.id);
      await writePlatformAudit(db, {
        ...auditBase,
        actorPlatformUserId: row.id,
        action: "platform.login.totp_failed",
        entity: "platform_user",
        entityId: row.id,
      });
      return { ok: false, errorKey: "errors.platformTotpInvalid", needTotp: true };
    }
  }

  // 4. success
  await db
    .update(platformUsers)
    .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(platformUsers.id, row.id));
  const { token, expiresAt } = await createSession({
    platformUserId: row.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  await writePlatformAudit(db, {
    ...auditBase,
    actorPlatformUserId: row.id,
    actorLabel: `${row.name} <${row.email}> [platform:${row.role}]`,
    action: "platform.login.success",
    entity: "platform_user",
    entityId: row.id,
    after: { withTotp: row.role === "owner" },
  });
  return { ok: true, token, expiresAt, name: row.name, role: row.role as "owner" | "ops" };
}

async function registerFailure(platformUserId: string): Promise<void> {
  const [row] = await db
    .select({ failed: platformUsers.failedLogins })
    .from(platformUsers)
    .where(eq(platformUsers.id, platformUserId))
    .limit(1);
  const failed = (row?.failed ?? 0) + 1;
  await db
    .update(platformUsers)
    .set({
      failedLogins: failed,
      lockedUntil:
        failed >= PLATFORM_MAX_FAILED ? new Date(Date.now() + PLATFORM_LOCK_MINUTES * 60_000) : null,
    })
    .where(eq(platformUsers.id, platformUserId));
}

/* ------------------------------------------------------------------ enrolment */

export interface EnrollmentStart {
  secret: string;
  uri: string;
  pendingToken: string;
}

/** Step 1: propose a secret (nothing is stored until a code verifies). */
export async function startTotpEnrollment(pendingToken: string): Promise<EnrollmentStart> {
  const pending = readPending(pendingToken, "2fa-enroll");
  if (!pending) throw new Error("enrollment link expired");
  const [row] = await db.select().from(platformUsers).where(eq(platformUsers.id, pending.platformUserId)).limit(1);
  if (!row) throw new Error("unknown platform user");
  const secret = generateTotpSecret();
  return {
    secret,
    uri: totpUri({ secret, account: row.email, issuer: "Hisab ERP" }),
    pendingToken: signPending(row.id, "2fa-enroll", secret),
  };
}

/** Step 2: verify a code for the proposed secret, then persist it encrypted. */
export async function confirmTotpEnrollment(input: {
  pendingToken: string;
  code: string;
  actorLabel: string;
  ip?: string | null;
}): Promise<{ ok: boolean; errorKey?: string; platformUserId?: string }> {
  const pending = readPending(input.pendingToken, "2fa-enroll");
  if (!pending || !pending.payload) return { ok: false, errorKey: "errors.platformTotpEnrollExpired" };
  const secret = pending.payload;
  if (!verifyTotp(secret, input.code)) {
    return { ok: false, errorKey: "errors.platformTotpInvalid" };
  }
  await db
    .update(platformUsers)
    .set({ totpSecretCipher: encryptSecret(secret), totpEnrolledAt: new Date(), failedLogins: 0, lockedUntil: null })
    .where(eq(platformUsers.id, pending.platformUserId));
  await writePlatformAudit(db, {
    actorPlatformUserId: pending.platformUserId,
    actorLabel: input.actorLabel,
    action: "platform.2fa.enrolled",
    entity: "platform_user",
    entityId: pending.platformUserId,
    ip: input.ip ?? null,
  });
  return { ok: true, platformUserId: pending.platformUserId };
}

/** Replace an enrolled secret (same pending-token flow, owner-initiated). */
export async function resetTotp(platformUserId: string, actorLabel: string): Promise<void> {
  await db
    .update(platformUsers)
    .set({ totpSecretCipher: null, totpEnrolledAt: null })
    .where(eq(platformUsers.id, platformUserId));
  await writePlatformAudit(db, {
    actorPlatformUserId: platformUserId,
    actorLabel,
    action: "platform.2fa.reset",
    entity: "platform_user",
    entityId: platformUserId,
  });
}

export async function platformLogout(sessionId: string, actorLabel: string): Promise<void> {
  await revokeSession(sessionId);
  await writePlatformAudit(db, { actorLabel, action: "platform.logout", entity: "session", entityId: sessionId });
}

/** Exposed for tests: the code an authenticator would show right now. */
export function debugTotpForSecret(secret: string): string {
  return currentTotp(secret);
}
