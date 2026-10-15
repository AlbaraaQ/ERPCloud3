"use server";

/**
 * Auth server actions — login/logout for tenant users.
 * Platform console login is separated (Phase 8).
 */

import { z } from "zod";
import argon2 from "argon2";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { logger } from "@/modules/shared/logger";
import { writeAudit } from "@/modules/shared/audit";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  getSessionContext,
  revokeSession,
  verifyPassword,
} from "./auth";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("errors.loginEmailInvalid"),
  password: z.string().min(1, "errors.loginPasswordRequired"),
});

export interface AuthFormState {
  errorKey?: string;
}

interface LoginLookupRow {
  user_id: string;
  tenant_id: string;
  tenant_status: string;
  tenant_name: string;
  password_hash: string;
  name: string;
  is_owner: boolean;
  status: string;
}

// Precomputed-once dummy hash to blunt user-enumeration timing (SEC §3).
let dummyHashPromise: Promise<string> | null = null;
const dummyHash = () =>
  (dummyHashPromise ??= argon2.hash("hisab-dummy-timing-password", {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 3,
    parallelism: 1,
  }));

async function clientMeta(): Promise<{ ip: string | null; ua: string | null }> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return {
    ip: fwd ? fwd.split(",")[0]!.trim() : (h.get("x-real-ip") ?? null),
    ua: h.get("user-agent"),
  };
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { errorKey: "errors.loginInvalidInput" };

  const { email, password } = parsed.data;
  const meta = await clientMeta();

  let rows: LoginLookupRow[] = [];
  try {
    const result = await db.execute(sql`select * from public.user_login_lookup(${email})`);
    rows = (result as unknown as { rows: LoginLookupRow[] }).rows ?? [];
  } catch (e) {
    logger.error({ err: e }, "login lookup failed");
    return { errorKey: "errors.unexpected" };
  }

  const found = rows[0] as LoginLookupRow | undefined;
  const hashToCheck = found ? found.password_hash : await dummyHash();
  const passwordOk = await verifyPassword(hashToCheck, password);

  const auditBase = {
    tenantId: found?.tenant_id ?? null,
    actorUserId: found?.user_id ?? null,
    actorPlatformUserId: null,
    actorLabel: found ? `${found.name} <${email}>` : email,
    ip: meta.ip,
    userAgent: meta.ua,
  };

  if (!found || !passwordOk) {
    await writeAudit(db, {
      ...auditBase,
      action: "auth.login.failed",
      entity: "user",
      entityId: found?.user_id ?? null,
    });
    return { errorKey: "errors.invalidCredentials" };
  }

  if (found.status !== "active") {
    await writeAudit(db, { ...auditBase, action: "auth.login.blocked_disabled", entity: "user", entityId: found.user_id });
    return { errorKey: "errors.accountDisabled" };
  }

  if (found.tenant_status === "suspended") {
    await writeAudit(db, {
      ...auditBase,
      action: "auth.login.blocked_suspended",
      entity: "tenant",
      entityId: found.tenant_id,
    });
    return { errorKey: "errors.tenantSuspended" };
  }
  if (found.tenant_status === "deactivated") {
    return { errorKey: "errors.tenantDeactivated" };
  }

  const { token, expiresAt } = await createSession({
    userId: found.user_id,
    tenantId: found.tenant_id,
    ip: meta.ip,
    userAgent: meta.ua,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  await writeAudit(db, {
    ...auditBase,
    action: "auth.login.success",
    entity: "user",
    entityId: found.user_id,
    after: { tenant: found.tenant_name },
  });

  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const ctx = await getSessionContext();
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  if (ctx) {
    await revokeSession(ctx.session.id);
    await writeAudit(db, {
      tenantId: ctx.tenant?.id ?? null,
      actorUserId: ctx.userId,
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: ctx.userEmail || ctx.userName || "unknown",
      action: "auth.logout",
      entity: "session",
      entityId: ctx.session.id,
    });
  }
  redirect("/login");
}
