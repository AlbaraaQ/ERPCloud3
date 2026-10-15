"use server";

/** Inventory server actions — permission-checked entry points (SEC §4). */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { requirePermission, serviceCtxOf, type ServiceCtx } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { todayBusinessDate } from "@/modules/shared/dates";
import { newId, newOpId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import { recordMovement } from "./stock";
import {
  createTransferDraft,
  dispatchTransfer,
  acceptTransfer,
  closeTransfer,
} from "./transfers";
import { products, transferLines } from "@/db/schema";
import type { ActionResult } from "@/modules/shared/action-result";

type Runner = (trx: Trx, ctx: ServiceCtx) => Promise<void | string>;

async function run(permission: string, fn: Runner): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  try {
    requirePermission(ctx, permission);
    const svc = serviceCtxOf(ctx);
    const okKey = await withTenant(ctx.tenant.id, (trx) => fn(trx, svc));
    revalidatePath("/inventory");
    revalidatePath("/dashboard");
    return { ok: true, okKey: typeof okKey === "string" ? okKey : undefined };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey };
    logger.error({ err: e }, "inventory action failed");
    return { ok: false, errorKey: "errors.unexpected" };
  }
}

const receiptSchema = z.object({
  warehouseId: z.string().uuid(),
  productId: z.string().uuid(),
  qty: z.string().min(1),
  cost: z.string().min(1),
  batchNo: z.string().optional(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  memo: z.string().max(300).optional(),
});

export async function receiveStockAction(formData: FormData): Promise<ActionResult> {
  const parsed = receiptSchema.safeParse({
    warehouseId: formData.get("warehouseId"),
    productId: formData.get("productId"),
    qty: formData.get("qty"),
    cost: formData.get("cost"),
    batchNo: formData.get("batchNo") || undefined,
    expiry: formData.get("expiry") || undefined,
    memo: formData.get("memo") || undefined,
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  return run("inventory.adjust", async (trx, ctx) => {
    const d = parsed.data;
    await recordMovement(trx, ctx, {
      warehouseId: d.warehouseId,
      productId: d.productId,
      qty: d.qty,
      movementType: "receive",
      unitCost: d.cost,
      lot: d.batchNo ? { batchNo: d.batchNo, expiryDate: d.expiry || null } : undefined,
      businessDate: todayBusinessDate(),
      sourceType: "manual_receipt",
      sourceId: newId(),
      effectKind: "receive",
      lineRef: newOpId(), // per-submit idempotency ref
      memo: d.memo ?? null,
    });
    return "inventory.receiptDone";
  });
}

const productSchema = z.object({
  sku: z.string().min(2).max(40),
  barcode: z.string().max(60).optional(),
  nameAr: z.string().min(2).max(200),
  nameEn: z.string().max(200).optional(),
  stockUnitId: z.string().uuid(),
  salePrice: z.string().default("0"),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  trackLots: z.boolean(),
  trackExpiry: z.boolean(),
});

export async function createProductAction(formData: FormData): Promise<ActionResult> {
  const parsed = productSchema.safeParse({
    sku: formData.get("sku"),
    barcode: formData.get("barcode") || undefined,
    nameAr: formData.get("nameAr"),
    nameEn: formData.get("nameEn") || undefined,
    stockUnitId: formData.get("stockUnitId"),
    salePrice: formData.get("salePrice") || "0",
    minPrice: formData.get("minPrice") || undefined,
    maxPrice: formData.get("maxPrice") || undefined,
    trackLots: formData.get("trackLots") === "on",
    trackExpiry: formData.get("trackExpiry") === "on",
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  return run("catalog.products.manage", async (trx, ctx) => {
    const d = parsed.data;
    await trx.insert(products).values({
      tenantId: ctx.tenantId,
      sku: d.sku.trim().toUpperCase(),
      barcode: d.barcode || null,
      nameAr: d.nameAr,
      nameEn: d.nameEn || null,
      stockUnitId: d.stockUnitId,
      salePrice: d.salePrice || "0",
      minPrice: d.minPrice || null,
      maxPrice: d.maxPrice || null,
      trackLots: d.trackLots,
      trackExpiry: d.trackExpiry,
    });
    await writeAudit(trx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.actorId,
      actorLabel: ctx.actorId ?? "system",
      action: "catalog.product.created",
      entity: "product",
      entityId: d.sku,
    });
    return "inventory.productCreated";
  });
}

const dispatchSchema = z.object({
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  productId: z.string().uuid(),
  qty: z.string().min(1),
});

export async function dispatchTransferFlowAction(formData: FormData): Promise<ActionResult> {
  const parsed = dispatchSchema.safeParse({
    fromWarehouseId: formData.get("fromWarehouseId"),
    toWarehouseId: formData.get("toWarehouseId"),
    productId: formData.get("productId"),
    qty: formData.get("qty"),
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  return run("inventory.transfer.dispatch", async (trx, ctx) => {
    const d = parsed.data;
    const id = await createTransferDraft(trx, ctx, {
      fromWarehouseId: d.fromWarehouseId,
      toWarehouseId: d.toWarehouseId,
      businessDate: todayBusinessDate(),
      lines: [{ productId: d.productId, qty: d.qty }],
    });
    await dispatchTransfer(trx, ctx, id);
    return "inventory.transferCreated";
  });
}

/** Accept all remaining quantities (full acceptance path of the state machine). */
export async function acceptTransferAction(formData: FormData): Promise<ActionResult> {
  const transferId = String(formData.get("transferId") ?? "");
  return run("inventory.transfer.receive", async (trx, ctx) => {
    const lines = await trx.select().from(transferLines).where(eq(transferLines.transferId, transferId));
    const accepts = lines
      .map((l) => ({
        lineId: l.id,
        qty: (Number(l.qtyDispatched) - Number(l.qtyReceived)).toString(),
      }))
      .filter((a) => Number(a.qty) > 0);
    if (accepts.length === 0) return "inventory.accepted";
    await acceptTransfer(trx, ctx, transferId, accepts, {
      businessDate: todayBusinessDate(),
      acceptRef: newOpId(),
    });
    return "inventory.accepted";
  });
}

export async function closeTransferAction(formData: FormData): Promise<ActionResult> {
  const transferId = String(formData.get("transferId") ?? "");
  return run("inventory.transfer.dispatch", async (trx, ctx) => {
    await closeTransfer(trx, ctx, transferId);
  });
}
