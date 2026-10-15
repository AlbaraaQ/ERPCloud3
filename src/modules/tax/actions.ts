"use server";

/** Tax configuration & submission actions (tax.configure / tax.view). */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant } from "@/modules/shared/db-context";
import { requirePermission, serviceCtxOf } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import type { ActionResult } from "@/modules/shared/action-result";
import { taxConfigs, zatcaCertificates } from "@/db/schema";
import { writeAudit } from "@/modules/shared/audit";
import { generateDeviceKeys } from "./crypto";
import {
  issueProductionCsid,
  renewProductionCsid,
  requestComplianceCsid,
  runComplianceChecks,
} from "./onboarding";
import { retrySubmission } from "./processor";
import { newId } from "@/modules/shared/ids";
import { db } from "@/db";
import { PgBoss } from "pg-boss";
import { ZATCA_QUEUE } from "@/modules/jobs/worker";

type Runner<T> = () => Promise<T>;

async function run<T>(permission: string, fn: Runner<T>): Promise<T & ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" } as T & ActionResult;
  try {
    requirePermission(ctx, permission);
    const svc = serviceCtxOf(ctx);
    const extra = await withTenant(ctx.tenant.id, async (trx) => {
      const out = await fn();
      await writeAudit(trx, {
        tenantId: ctx.tenant!.id,
        actorUserId: svc.actorId,
        actorLabel: svc.actorId ?? "system",
        action: "tax.action",
        entity: "tax_config",
        entityId: ctx.tenant!.id,
        after: { permission },
      });
      return out;
    });
    revalidatePath("/tax");
    return { ok: true, ...extra } as T & ActionResult;
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as T & ActionResult;
    logger.error({ err: e }, "tax action failed");
    return { ok: false, errorKey: "errors.unexpected" } as T & ActionResult;
  }
}

const cfgSchema = z.object({
  enabled: z.boolean(),
  env: z.enum(["developer-portal", "simulation", "core"]),
  street: z.string().max(200).nullish(),
  district: z.string().max(120).nullish(),
  city: z.string().max(120).nullish(),
  postalCode: z.string().max(10).nullish(),
  industry: z.string().max(120).nullish(),
  freeGoodsDeemedSupply: z.boolean(),
});

export async function saveTaxConfigAction(formData: FormData): Promise<ActionResult> {
  const parsed = cfgSchema.safeParse({
    enabled: formData.get("enabled") === "true",
    env: formData.get("env") || "developer-portal",
    street: formData.get("street") || null,
    district: formData.get("district") || null,
    city: formData.get("city") || null,
    postalCode: formData.get("postalCode") || null,
    industry: formData.get("industry") || null,
    freeGoodsDeemedSupply: formData.get("freeGoodsDeemedSupply") === "true",
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  const ctx = await getSessionContext();
  return withTenant(ctx!.tenant!.id, async (trx) => {
    try {
      requirePermission(ctx!, "tax.configure");
      const [before] = await trx.select().from(taxConfigs).where(eq(taxConfigs.tenantId, ctx!.tenant!.id)).limit(1);
      await trx
        .insert(taxConfigs)
        .values({ tenantId: ctx!.tenant!.id, ...parsed.data })
        .onConflictDoUpdate({ target: taxConfigs.tenantId, set: { ...parsed.data, updatedAt: new Date() } });
      await writeAudit(trx, {
        tenantId: ctx!.tenant!.id,
        actorUserId: ctx!.userId,
        actorLabel: ctx!.userEmail,
        action: "tax.config.saved",
        entity: "tax_config",
        entityId: ctx!.tenant!.id,
        before: before ? { enabled: before.enabled, env: before.env, city: before.city } : null,
        after: { enabled: parsed.data.enabled, env: parsed.data.env, city: parsed.data.city },
      });
      revalidatePath("/tax");
      return { ok: true } as ActionResult;
    } catch (e) {
      if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as ActionResult;
      logger.error({ err: e }, "saveTaxConfig failed");
      return { ok: false, errorKey: "errors.unexpected" } as ActionResult;
    }
  });
}

/** Generate the EGS device keypair (secp256k1) for the configured environment. */
export async function generateDeviceKeyAction(): Promise<ActionResult> {
  const ctx = await getSessionContext();
  return withTenant(ctx!.tenant!.id, async (trx) => {
    try {
      requirePermission(ctx!, "tax.configure");
      const [cfg] = await trx.select().from(taxConfigs).where(eq(taxConfigs.tenantId, ctx!.tenant!.id)).limit(1);
      if (!cfg) return { ok: false, errorKey: "errors.taxNotEnabled" } as ActionResult;
      const keys = generateDeviceKeys();
      await trx
        .update(zatcaCertificates)
        .set({ status: "rotated" })
        .where(
          and(
            eq(zatcaCertificates.tenantId, ctx!.tenant!.id),
            eq(zatcaCertificates.env, cfg.env),
            eq(zatcaCertificates.kind, "device_key"),
          ),
        );
      await trx.insert(zatcaCertificates).values({
        tenantId: ctx!.tenant!.id,
        env: cfg.env,
        kind: "device_key",
        label: "EGS device key",
        privateKey: keys.privateKeyPem,
        publicKey: keys.publicKeySpkiPem,
        status: "active",
      });
      await writeAudit(trx, {
        tenantId: ctx!.tenant!.id,
        actorUserId: ctx!.userId,
        actorLabel: ctx!.userEmail,
        action: "tax.device_key.generated",
        entity: "zatca_certificate",
        entityId: cfg.env,
        after: { env: cfg.env, kind: "device_key" },
      });
      revalidatePath("/tax");
      return { ok: true } as ActionResult;
    } catch (e) {
      if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as ActionResult;
      logger.error({ err: e }, "generateDeviceKey failed");
      return { ok: false, errorKey: "errors.unexpected" } as ActionResult;
    }
  });
}

/** Paste portal credentials (compliance/production CSID token + secret). */
export async function saveCredentialAction(formData: FormData): Promise<ActionResult> {
  const kind = String(formData.get("kind") ?? "production");
  const token = String(formData.get("binarySecurityToken") ?? "");
  const secret = String(formData.get("secret") ?? "");
  if (!token || !secret) return { ok: false, errorKey: "errors.loginInvalidInput" };
  if (!["compliance", "production"].includes(kind)) return { ok: false, errorKey: "errors.loginInvalidInput" };
  const ctx = await getSessionContext();
  return withTenant(ctx!.tenant!.id, async (trx) => {
    try {
      requirePermission(ctx!, "tax.configure");
      const [cfg] = await trx.select().from(taxConfigs).where(eq(taxConfigs.tenantId, ctx!.tenant!.id)).limit(1);
      if (!cfg) return { ok: false, errorKey: "errors.taxNotEnabled" } as ActionResult;
      await trx
        .update(zatcaCertificates)
        .set({ status: "rotated" })
        .where(
          and(
            eq(zatcaCertificates.tenantId, ctx!.tenant!.id),
            eq(zatcaCertificates.env, cfg.env),
            eq(zatcaCertificates.kind, kind),
          ),
        );
      await trx.insert(zatcaCertificates).values({
        id: newId(),
        tenantId: ctx!.tenant!.id,
        env: cfg.env,
        kind,
        label: `${kind} CSID (${cfg.env})`,
        binarySecurityToken: token,
        secret,
        status: "active",
      });
      await trx
        .update(taxConfigs)
        .set({ onboardingState: kind })
        .where(eq(taxConfigs.tenantId, ctx!.tenant!.id));
      await writeAudit(trx, {
        tenantId: ctx!.tenant!.id,
        actorUserId: ctx!.userId,
        actorLabel: ctx!.userEmail,
        action: "tax.credential.saved",
        entity: "zatca_certificate",
        entityId: `${kind}/${cfg.env}`,
        after: { kind, env: cfg.env, tokenPrefix: token.slice(0, 8) },
      });
      revalidatePath("/tax");
      return { ok: true } as ActionResult;
    } catch (e) {
      if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as ActionResult;
      logger.error({ err: e }, "saveCredential failed");
      return { ok: false, errorKey: "errors.unexpected" } as ActionResult;
    }
  });
}

/** Manual retry for a transport-failed submission (re-queued, same uuid/ICV). */
export async function retrySubmissionAction(formData: FormData): Promise<ActionResult> {
  const submissionId = String(formData.get("submissionId") ?? "");
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  return run("tax.view", async () => {
    await retrySubmission(ctx.tenant!.id, submissionId, ctx.userId!);
    // kick the worker queue immediately (best effort)
    try {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
      await boss.start();
      await boss.send(ZATCA_QUEUE, {});
      await boss.stop();
    } catch (e) {
      logger.warn({ err: e }, "immediate zatca kick failed — scheduled cycle will retry");
    }
  });
}

/* ------------------------------------------------------ onboarding (D-024) */

/**
 * Automated onboarding: the whole CSR → compliance CSID → six compliance checks
 * → production CSID cycle runs from the tax screen. The manual credential form
 * above stays available for integrations that onboard elsewhere (documented
 * fallback, same tables).
 */
export async function startOnboardingAction(formData: FormData): Promise<ActionResult> {
  const otp = String(formData.get("otp") ?? "").trim();
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  return withTenant(ctx.tenant.id, async (trx) => {
    try {
      requirePermission(ctx, "tax.configure");
      const out = await requestComplianceCsid(trx, ctx.tenant!.id, { otp, actorId: ctx.userId! });
      revalidatePath("/tax");
      return { ok: out.ok, errorKey: out.ok ? undefined : "errors.zatcaOnboardingFailed", okKey: out.message } as ActionResult;
    } catch (e) {
      if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as ActionResult;
      logger.error({ err: e }, "startOnboarding failed");
      return { ok: false, errorKey: "errors.unexpected" } as ActionResult;
    }
  });
}

export async function runComplianceChecksAction(): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  return withTenant(ctx.tenant.id, async (trx) => {
    try {
      requirePermission(ctx, "tax.configure");
      const out = await runComplianceChecks(trx, ctx.tenant!.id, ctx.userId!);
      revalidatePath("/tax");
      return { ok: out.ok, errorKey: out.ok ? undefined : "errors.zatcaComplianceFailed", okKey: out.message } as ActionResult;
    } catch (e) {
      if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as ActionResult;
      logger.error({ err: e }, "runComplianceChecks failed");
      return { ok: false, errorKey: "errors.unexpected" } as ActionResult;
    }
  });
}

export async function issueProductionCsidAction(): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  return withTenant(ctx.tenant.id, async (trx) => {
    try {
      requirePermission(ctx, "tax.configure");
      const out = await issueProductionCsid(trx, ctx.tenant!.id, ctx.userId!);
      revalidatePath("/tax");
      return { ok: out.ok, errorKey: out.ok ? undefined : "errors.zatcaOnboardingFailed", okKey: out.message } as ActionResult;
    } catch (e) {
      if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as ActionResult;
      logger.error({ err: e }, "issueProductionCsid failed");
      return { ok: false, errorKey: "errors.unexpected" } as ActionResult;
    }
  });
}

export async function renewProductionCsidAction(): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  return withTenant(ctx.tenant.id, async (trx) => {
    try {
      requirePermission(ctx, "tax.configure");
      const out = await renewProductionCsid(trx, ctx.tenant!.id, ctx.userId!);
      revalidatePath("/tax");
      return { ok: out.ok, errorKey: out.ok ? undefined : "errors.zatcaOnboardingFailed", okKey: out.message } as ActionResult;
    } catch (e) {
      if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as ActionResult;
      logger.error({ err: e }, "renewProductionCsid failed");
      return { ok: false, errorKey: "errors.unexpected" } as ActionResult;
    }
  });
}
