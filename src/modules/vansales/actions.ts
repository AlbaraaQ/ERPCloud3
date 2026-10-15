"use server";

/** Van-sales & settlement server actions. */

import { revalidatePath } from "next/cache";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import {
  requirePermission, serviceCtxOf, hasPermission, type ServiceCtx,
} from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { todayBusinessDate } from "@/modules/shared/dates";
import type { ActionResult } from "@/modules/shared/action-result";
import { provisionRepresentative } from "./provisioning";
import {
  requestSettlement, openForReview, recordCounts, approveException, closeSettlement,
} from "./settlement";

type Runner<T> = (trx: Trx, ctx: ServiceCtx) => Promise<T>;

async function run<T>(permission: string | null, fn: Runner<T>, path = "/rep"): Promise<T & ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" } as T & ActionResult;
  try {
    if (permission) requirePermission(ctx, permission);
    const svc = serviceCtxOf(ctx);
    const extra = await withTenant(ctx.tenant.id, (trx) => fn(trx, svc));
    revalidatePath(path);
    revalidatePath("/settlement");
    return { ok: true, ...extra } as T & ActionResult;
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as T & ActionResult;
    logger.error({ err: e }, "vansales action failed");
    return { ok: false, errorKey: "errors.unexpected" } as T & ActionResult;
  }
}

/**
 * Self-provisioning for the rep flow demo: allowed when the caller already
 * holds rep permissions (vansales.pos.own) and has no custody warehouse yet.
 * Admin path: provisionUserAction requires settings.users.manage.
 */
export async function provisionSelfAction(): Promise<ActionResult & { custodyWarehouseId?: string }> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  if (!hasPermission(ctx, "vansales.pos.own")) {
    return { ok: false, errorKey: "errors.permissionDenied" };
  }
  return run<{ custodyWarehouseId: string }>(null, async (trx, svc) => {
    const r = await provisionRepresentative(trx, svc, ctx.userId!);
    return { custodyWarehouseId: r.custodyWarehouseId };
  });
}

export async function provisionUserAction(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  return run("settings.users.manage", async (trx, svc) => {
    await provisionRepresentative(trx, svc, userId);
  }, "/settlement");
}

/** Rep requests settlement of the current day (idempotent per open request). */
export async function requestSettlementSelfAction(): Promise<ActionResult & { settlementNo?: number }> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  return run<{ settlementNo: number }>(null, async (trx, svc) => {
    const r = await requestSettlement(trx, svc, ctx.userId!, todayBusinessDate());
    return { settlementNo: r.settlementNo };
  });
}

export async function openReviewAction(formData: FormData): Promise<ActionResult> {
  const settlementId = String(formData.get("settlementId") ?? "");
  return run("settlement.review", async (trx, svc) => {
    await openForReview(trx, svc, settlementId);
  }, "/settlement");
}

export async function recordCountsAction(formData: FormData): Promise<ActionResult> {
  const settlementId = String(formData.get("settlementId") ?? "");
  const countedCash = String(formData.get("countedCash") ?? "0");
  const linesJson = String(formData.get("linesJson") ?? "[]");
  return run("settlement.review", async (trx, svc) => {
    await recordCounts(trx, svc, settlementId, {
      countedCash,
      lines: JSON.parse(linesJson) as { productId: string; countedQty: string }[],
    });
  }, "/settlement");
}

export async function approveExceptionAction(formData: FormData): Promise<ActionResult> {
  const exceptionId = String(formData.get("exceptionId") ?? "");
  const note = String(formData.get("note") ?? "");
  return run("settlement.exception.approve", async (trx, svc) => {
    await approveException(trx, svc, exceptionId, note || undefined);
  }, "/settlement");
}

export async function closeSettlementAction(formData: FormData): Promise<ActionResult> {
  const settlementId = String(formData.get("settlementId") ?? "");
  return run("settlement.finalize", async (trx, svc) => {
    await closeSettlement(trx, svc, settlementId);
  }, "/settlement");
}
