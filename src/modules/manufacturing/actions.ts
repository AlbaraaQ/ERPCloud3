"use server";

/** Manufacturing server actions. */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { requirePermission, serviceCtxOf, type ServiceCtx } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { todayBusinessDate } from "@/modules/shared/dates";
import type { ActionResult } from "@/modules/shared/action-result";
import {
  createBom, createProductionOrder, startProduction, addCostComponent,
  recordScrap, completeProduction, cancelProductionOrder, traceRecall,
} from "./production";

type Runner<T> = (trx: Trx, ctx: ServiceCtx) => Promise<T>;

async function run<T>(fn: Runner<T>): Promise<T & ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" } as T & ActionResult;
  try {
    requirePermission(ctx, "production.manage");
    const svc = serviceCtxOf(ctx);
    const extra = await withTenant(ctx.tenant.id, (trx) => fn(trx, svc));
    revalidatePath("/manufacturing");
    revalidatePath("/inventory");
    return { ok: true, ...extra } as T & ActionResult;
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as T & ActionResult;
    logger.error({ err: e }, "manufacturing action failed");
    return { ok: false, errorKey: "errors.unexpected" } as T & ActionResult;
  }
}

const bomSchema = z.object({
  productId: z.string().uuid(),
  name: z.string().min(2).max(160),
  yieldQty: z.string(),
  notes: z.string().max(500).nullish(),
  linesJson: z.string(),
});

export async function createBomAction(formData: FormData): Promise<ActionResult> {
  const parsed = bomSchema.safeParse({
    productId: formData.get("productId"),
    name: formData.get("name"),
    yieldQty: formData.get("yieldQty"),
    notes: formData.get("notes") || null,
    linesJson: formData.get("linesJson"),
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  const lines = z
    .array(z.object({ productId: z.string().uuid(), qty: z.string() }))
    .min(1)
    .safeParse(JSON.parse(parsed.data.linesJson));
  if (!lines.success) return { ok: false, errorKey: "errors.bomEmpty" };
  return run(async (trx, ctx) => {
    await createBom(trx, ctx, { ...parsed.data, notes: parsed.data.notes ?? null, lines: lines.data });
  });
}

export async function createOrderAction(formData: FormData): Promise<ActionResult & { orderId?: string }> {
  return run<{ orderId: string }>(async (trx, ctx) => {
    const orderId = await createProductionOrder(trx, ctx, {
      bomId: String(formData.get("bomId") ?? ""),
      plannedQty: String(formData.get("plannedQty") ?? ""),
      fromWarehouseId: String(formData.get("fromWarehouseId") ?? ""),
      toWarehouseId: String(formData.get("toWarehouseId") ?? ""),
      businessDate: todayBusinessDate(),
    });
    return { orderId };
  });
}

export async function startOrderAction(formData: FormData): Promise<ActionResult> {
  const orderId = String(formData.get("orderId") ?? "");
  const overrides = JSON.parse(String(formData.get("overridesJson") ?? "{}")) as Record<string, string>;
  return run(async (trx, ctx) => {
    await startProduction(trx, ctx, orderId, overrides);
  });
}

export async function addComponentAction(formData: FormData): Promise<ActionResult> {
  const orderId = String(formData.get("orderId") ?? "");
  return run(async (trx, ctx) => {
    await addCostComponent(trx, ctx, orderId, {
      kind: String(formData.get("kind") ?? "labor") as "labor" | "overhead" | "other",
      description: String(formData.get("description") ?? ""),
      amount: String(formData.get("amount") ?? "0"),
    });
  });
}

export async function recordScrapAction(formData: FormData): Promise<ActionResult> {
  const orderId = String(formData.get("orderId") ?? "");
  return run(async (trx, ctx) => {
    await recordScrap(trx, ctx, orderId, {
      productId: String(formData.get("productId") ?? ""),
      qty: String(formData.get("qty") ?? "0"),
      abnormal: formData.get("abnormal") === "true",
      note: String(formData.get("note") ?? "") || undefined,
    });
  });
}

export async function completeOrderAction(formData: FormData): Promise<ActionResult & { unitCost?: string }> {
  const orderId = String(formData.get("orderId") ?? "");
  const expiry = String(formData.get("expiryDate") ?? "");
  return run<{ unitCost: string }>(async (trx, ctx) => {
    const r = await completeProduction(trx, ctx, orderId, {
      outputQty: String(formData.get("outputQty") ?? "0"),
      expiryDate: expiry || null,
    });
    return { unitCost: r.unitCost };
  });
}

export async function cancelOrderAction(formData: FormData): Promise<ActionResult> {
  const orderId = String(formData.get("orderId") ?? "");
  return run(async (trx, ctx) => {
    await cancelProductionOrder(trx, ctx, orderId);
  });
}

export interface RecallTraceResult {
  output: Record<string, unknown> | null;
  order: Record<string, unknown> | null;
  consumedLots: Record<string, unknown>[];
  sales: Record<string, unknown>[];
  errorKey?: string;
}

/** Read-only recall trace for the lot-experience UI (reports.view permission). */
export async function traceRecallAction(lotId: string): Promise<RecallTraceResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { output: null, order: null, consumedLots: [], sales: [], errorKey: "errors.sessionInvalid" };
  try {
    requirePermission(ctx, "inventory.view");
    const svc = serviceCtxOf(ctx);
    const res = await withTenant(ctx.tenant.id, (trx) => traceRecall(trx, ctx.tenant!.id, lotId));
    return res as RecallTraceResult;
  } catch (e) {
    if (isDomainError(e)) return { output: null, order: null, consumedLots: [], sales: [], errorKey: e.messageKey };
    logger.error({ err: e }, "trace failed");
    return { output: null, order: null, consumedLots: [], sales: [], errorKey: "errors.unexpected" };
  }
}
