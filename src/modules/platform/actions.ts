"use server";

/**
 * Platform console server actions (PLATFORM_ADMIN.md).
 *
 * Rules applied uniformly here:
 *   - every action starts by loading the platform context and requiring the
 *     matching permission (`requirePlatformPermission`) — the UI never decides;
 *   - every mutation writes the platform audit chain (and mirrors tenant-facing
 *     events into the tenant chain);
 *   - destructive or irreversible steps (restore, purge) are Owner-only, need a
 *     typed confirmation and are recorded with their evidence.
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PLATFORM_SESSION_COOKIE, PLATFORM_SESSION_TTL_MS } from "./session";
import {
  confirmTotpEnrollment,
  platformLogin,
  platformLogout,
  startTotpEnrollment,
} from "./auth";
import {
  getPlatformContext,
  platformActorLabel,
  requirePlatformPermission,
  requirePlatformOwner,
} from "./context";
import { writePlatformAudit } from "./audit";
import { createSession, revokeSession } from "@/modules/identity/auth";
import { toDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import type { ActionResult } from "@/modules/shared/action-result";
import {
  provisionTenant,
  setFlag,
  setTenantPlan,
  setTenantStatus,
  type TenantStatus,
} from "./tenants";
import { getSettings, saveSettings, type PlatformSettings } from "./settings";
import {
  backupFreshness,
  listBackupRuns,
  pruneBackups,
  runBackup,
  runRestoreDrill,
  verifyBackup,
} from "./backup/service";
import { acknowledgeAlert } from "./alerts";
import { approveGrant, requestGrant, revokeGrant, tenantOwnerUserId } from "./grants";
import {
  buildTenantExport,
  exportToken,
  markExportOffered,
  purgeTenant,
  requestDeletion,
  setLegalHold,
} from "./exports";

export interface PlatformFormState extends ActionResult {
  /** transient value the UI must show once (e.g. a fresh TOTP secret) */
  data?: Record<string, unknown>;
  redirectTo?: string;
}

const TOTP_PENDING_COOKIE = "hisab_platform_2fa";

async function meta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return { ip: fwd ? fwd.split(",")[0]!.trim() : (h.get("x-real-ip") ?? null), userAgent: h.get("user-agent") };
}

function fail(e: unknown, fallback = "errors.unexpected"): PlatformFormState {
  const err = toDomainError(e, fallback);
  if (err.messageKey !== fallback) logger.warn({ detail: err.detail, kind: err.kind }, err.messageKey);
  return { ok: false, errorKey: err.messageKey };
}

async function guard(permission: string) {
  const ctx = await getPlatformContext();
  return requirePlatformPermission(ctx, permission);
}

/* ---------------------------------------------------------------------- auth */

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

export async function platformLoginAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    totp: formData.get("totp")?.toString() || undefined,
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };

  const { ip, userAgent } = await meta();
  const result = await platformLogin({ ...parsed.data, ip, userAgent });

  if (!result.ok) {
    if (result.needEnrollment && result.pendingToken) {
      const store = await cookies();
      store.set(TOTP_PENDING_COOKIE, result.pendingToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/platform",
        maxAge: 600,
      });
      return { ok: false, errorKey: result.errorKey, redirectTo: "/platform/login/enroll" };
    }
    return { ok: false, errorKey: result.errorKey };
  }

  const store = await cookies();
  store.delete(TOTP_PENDING_COOKIE);
  store.set(PLATFORM_SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: result.expiresAt,
    maxAge: Math.floor(PLATFORM_SESSION_TTL_MS / 1000),
  });
  redirect("/platform");
}

/**
 * Enrolment (PLATFORM_ADMIN §0: mandatory 2FA for the Owner role).
 *
 * step=start   → propose a secret (returned once, kept in a signed pending cookie)
 * step=confirm → verify a code for that secret, persist it encrypted, sign in
 */
export async function platformEnrollmentAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  const store = await cookies();
  const pendingToken = store.get(TOTP_PENDING_COOKIE)?.value;
  if (!pendingToken) return { ok: false, errorKey: "errors.platformTotpEnrollExpired" };
  const step = String(formData.get("step") ?? "start");

  try {
    if (step === "start") {
      const start = await startTotpEnrollment(pendingToken);
      store.set(TOTP_PENDING_COOKIE, start.pendingToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/platform",
        maxAge: 600,
      });
      return { ok: true, data: { secret: start.secret, uri: start.uri } };
    }

    const code = String(formData.get("code") ?? "");
    const result = await confirmTotpEnrollment({
      pendingToken,
      code,
      actorLabel: "platform-enrollment",
      ip: (await meta()).ip,
    });
    if (!result.ok) return { ok: false, errorKey: result.errorKey };

    // the pending token was signed for this user, so enrolment doubles as login
    const { token, expiresAt } = await createSession({ platformUserId: result.platformUserId });
    store.delete(TOTP_PENDING_COOKIE);
    store.set(PLATFORM_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
      maxAge: Math.floor(PLATFORM_SESSION_TTL_MS / 1000),
    });
    redirect("/platform");
  } catch (e) {
    return fail(e);
  }
}

export async function platformLogoutAction(): Promise<void> {
  const ctx = await getPlatformContext();
  const store = await cookies();
  store.delete(PLATFORM_SESSION_COOKIE);
  if (ctx) {
    await platformLogout(ctx.sessionId, platformActorLabel(ctx));
  }
  redirect("/platform/login");
}

/** Revoke a platform session by id (owner-only safety valve). */
export async function platformRevokeSessionAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.audit.view");
    const sessionId = String(formData.get("sessionId") ?? "");
    await revokeSession(sessionId);
    await writePlatformAudit((await import("@/db")).db, {
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: platformActorLabel(ctx),
      action: "platform.session_revoked",
      entity: "session",
      entityId: sessionId,
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------- tenants */

export async function tenantCreateAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState & { tenantId?: string }> {
  try {
    const ctx = await guard("platform.tenants.manage");
    const { ip, userAgent } = await meta();
    const settings = await getSettings();
    const result = await provisionTenant({
      name: String(formData.get("name") ?? "").trim(),
      nameEn: (formData.get("nameEn")?.toString() || null) ?? null,
      legalName: String(formData.get("legalName") ?? formData.get("name") ?? "").trim(),
      vatNumber: (formData.get("vatNumber")?.toString() || null) ?? null,
      planCode: String(formData.get("planCode") ?? settings.defaultPlanCode),
      trialDays: Number(formData.get("trialDays") ?? 14),
      ownerEmail: String(formData.get("ownerEmail") ?? ""),
      ownerName: String(formData.get("ownerName") ?? ""),
      ownerPassword: String(formData.get("ownerPassword") ?? ""),
      actorLabel: platformActorLabel(ctx),
      actorPlatformUserId: ctx.platformUserId,
    });
    const { db } = await import("@/db");
    await writePlatformAudit(db, {
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: platformActorLabel(ctx),
      action: "tenant.provisioned",
      entity: "tenant",
      entityId: result.tenantId,
      ip,
      userAgent,
      alsoAuditTenantId: result.tenantId,
    });
    return { ok: true, okKey: "platform.tenantCreated", tenantId: result.tenantId };
  } catch (e) {
    return fail(e);
  }
}

export async function tenantStatusAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.tenants.manage");
    const { ip, userAgent } = await meta();
    await setTenantStatus({
      tenantId: String(formData.get("tenantId") ?? ""),
      to: String(formData.get("to") ?? "suspended") as TenantStatus,
      reason: String(formData.get("reason") ?? ""),
      actorLabel: platformActorLabel(ctx),
      actorPlatformUserId: ctx.platformUserId,
      ip,
      userAgent,
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function tenantPlanAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.plans.manage");
    const renewsRaw = formData.get("renewsAt")?.toString();
    await setTenantPlan({
      tenantId: String(formData.get("tenantId") ?? ""),
      planCode: String(formData.get("planCode") ?? ""),
      actorLabel: platformActorLabel(ctx),
      actorPlatformUserId: ctx.platformUserId,
      renewsAt: renewsRaw ? new Date(renewsRaw) : null,
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function flagSetAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.flags.manage");
    const tenantId = formData.get("tenantId")?.toString() || null;
    await setFlag({
      tenantId,
      key: String(formData.get("key") ?? ""),
      enabled: formData.get("enabled") === "on" || formData.get("enabled") === "true",
      note: formData.get("note")?.toString() ?? null,
      actorLabel: platformActorLabel(ctx),
      actorPlatformUserId: ctx.platformUserId,
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------- backups */

export async function backupRunAction(): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.backup.run");
    const result = await runBackup({ kind: "manual", actorLabel: platformActorLabel(ctx) });
    return { ok: result.status === "verified", okKey: "platform.backupVerified", data: { ...result } };
  } catch (e) {
    return fail(e);
  }
}

export async function backupVerifyAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    await guard("platform.backup.verify");
    const result = await verifyBackup(String(formData.get("runId") ?? ""));
    return { ok: result.status === "verified", okKey: "platform.backupVerified" };
  } catch (e) {
    return fail(e);
  }
}

export async function backupDrillAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.backup.verify");
    const result = await runRestoreDrill({
      runId: formData.get("runId")?.toString() || undefined,
      actorLabel: platformActorLabel(ctx),
    });
    const { db } = await import("@/db");
    await writePlatformAudit(db, {
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: platformActorLabel(ctx),
      action: "backup.restore_drill",
      entity: "backup_run",
      entityId: result.runId,
      after: { status: result.status, rows: result.rows, durationMs: result.durationMs },
    });
    return {
      ok: result.status === "passed",
      okKey: "platform.drillPassed",
      errorKey: result.status === "passed" ? undefined : "errors.drillFailed",
      data: { status: result.status, rows: result.rows, tables: result.tables, durationMs: result.durationMs },
    };
  } catch (e) {
    return fail(e);
  }
}

export async function backupPruneAction(): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.backup.run");
    const result = await pruneBackups();
    const { db } = await import("@/db");
    await writePlatformAudit(db, {
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: platformActorLabel(ctx),
      action: "backup.pruned",
      entity: "backup_run",
      after: { pruned: result.pruned, deletedFiles: result.deletedFiles },
    });
    return { ok: true, okKey: "platform.saved", data: { ...result } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Production restore (BACKUP_AND_RECOVERY §6) intentionally does NOT run from the
 * console in this build: replacing a live database needs the incident runbook,
 * a two-person quorum and a maintenance window. The action records the attempt
 * and refuses — the console's real restore capability is the isolated drill.
 */
export async function backupRestoreAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await requirePlatformOwner(await getPlatformContext());
    requirePlatformPermission(ctx, "platform.backup.restore");
    const { db } = await import("@/db");
    await writePlatformAudit(db, {
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: platformActorLabel(ctx),
      action: "backup.restore_refused",
      entity: "backup_run",
      entityId: String(formData.get("runId") ?? ""),
      after: { reason: "production restore requires the documented runbook (§6)" },
    });
    return { ok: false, errorKey: "errors.restoreRunbookRequired" };
  } catch (e) {
    return fail(e);
  }
}

export async function backupPolicyAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.settings.manage");
    const patch: Partial<PlatformSettings> = {
      backup: {
        directory: formData.get("directory")?.toString() || undefined,
        keepLatest: Number(formData.get("keepLatest") ?? 18),
        keepDaily: Number(formData.get("keepDaily") ?? 14),
        keepWeekly: Number(formData.get("keepWeekly") ?? 8),
        staleAfterHours: Number(formData.get("staleAfterHours") ?? 8),
        uploadToRemote: formData.get("uploadToRemote") === "on",
      } as PlatformSettings["backup"],
      deletionCoolingOffDays: Number(formData.get("coolingOffDays") ?? 14),
      driveFolderId: formData.get("driveFolderId")?.toString() || null,
      supportGrantMaxHours: Number(formData.get("grantMaxHours") ?? 24),
    };
    const saved = await saveSettings(patch, platformActorLabel(ctx));
    const { db } = await import("@/db");
    await writePlatformAudit(db, {
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: platformActorLabel(ctx),
      action: "platform.settings_saved",
      entity: "settings",
      entityId: "platform",
      after: saved as unknown as Record<string, unknown>,
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

/* -------------------------------------------------------------------- alerts */

export async function alertAcknowledgeAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.alerts.manage");
    await acknowledgeAlert(String(formData.get("alertId") ?? ""), ctx.platformUserId);
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

/* -------------------------------------------------------------------- grants */

export async function grantRequestAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState & { grantId?: string }> {
  try {
    const ctx = await guard("platform.grants.request");
    const tenantId = String(formData.get("tenantId") ?? "");
    const screens = formData.getAll("screens").map(String);
    const grantId = await requestGrant({
      tenantId,
      requestedByPlatformUserId: ctx.platformUserId,
      tenantApprovedByUserId: await tenantOwnerUserId(tenantId),
      scope: {
        screens,
        amounts: formData.get("amounts") === "on",
        exports: formData.get("exports") === "on",
      },
      reason: String(formData.get("reason") ?? ""),
      hours: Number(formData.get("hours") ?? 4),
      actorLabel: platformActorLabel(ctx),
    });
    return { ok: true, okKey: "platform.grantRequested", grantId };
  } catch (e) {
    return fail(e);
  }
}

export async function grantApproveAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.grants.approve");
    await approveGrant({
      grantId: String(formData.get("grantId") ?? ""),
      approverPlatformUserId: ctx.platformUserId,
      approverRole: ctx.role,
      actorLabel: platformActorLabel(ctx),
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function grantRevokeAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.grants.revoke");
    await revokeGrant({
      grantId: String(formData.get("grantId") ?? ""),
      actorPlatformUserId: ctx.platformUserId,
      actorLabel: platformActorLabel(ctx),
      reason: String(formData.get("reason") ?? ""),
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

/* --------------------------------------------------------- exports & deletion */

export async function exportBuildAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.exports.manage");
    const tenantId = String(formData.get("tenantId") ?? "");
    const result = await buildTenantExport({
      tenantId,
      actorLabel: platformActorLabel(ctx),
      requestedByPlatformUserId: ctx.platformUserId,
    });
    const requestId = formData.get("requestId")?.toString();
    if (requestId) await markExportOffered(requestId, result.exportId);
    return {
      ok: true,
      okKey: "platform.exportReady",
      data: {
        exportId: result.exportId,
        bytes: result.bytes,
        tables: result.tables.length,
        token: exportToken(result.exportId, result.expiresAt.getTime()),
      },
    };
  } catch (e) {
    return fail(e);
  }
}

export async function deletionRequestAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.data.delete");
    await requestDeletion({
      tenantId: String(formData.get("tenantId") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      actorLabel: platformActorLabel(ctx),
      actorPlatformUserId: ctx.platformUserId,
    });
    return { ok: true, okKey: "platform.deletionRequested" };
  } catch (e) {
    return fail(e);
  }
}

export async function deletionLegalHoldAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await guard("platform.data.delete");
    await setLegalHold({
      requestId: String(formData.get("requestId") ?? ""),
      hold: formData.get("hold") === "on" || formData.get("hold") === "true",
      note: formData.get("note")?.toString(),
      actorLabel: platformActorLabel(ctx),
      actorPlatformUserId: ctx.platformUserId,
    });
    return { ok: true, okKey: "platform.saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function deletionPurgeAction(
  _prev: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  try {
    const ctx = await requirePlatformOwner(await getPlatformContext());
    requirePlatformPermission(ctx, "platform.data.delete");
    const result = await purgeTenant({
      requestId: String(formData.get("requestId") ?? ""),
      actorLabel: platformActorLabel(ctx),
      actorPlatformUserId: ctx.platformUserId,
      confirmation: String(formData.get("confirmation") ?? ""),
    });
    return { ok: true, okKey: "platform.purged", data: { ...result.certificate } };
  } catch (e) {
    return fail(e);
  }
}
