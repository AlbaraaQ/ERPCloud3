"use server";

/** Purchasing server actions. */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { requirePermission, serviceCtxOf, type ServiceCtx } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { todayBusinessDate } from "@/modules/shared/dates";
import type { ActionResult } from "@/modules/shared/action-result";
import { createPurchaseDraft, postPurchaseInvoice, createSupplierPayment } from "./purchases";

type Runner<T> = (trx: Trx, ctx: ServiceCtx) => Promise<T>;

async function run<T>(permission: string, fn: Runner<T>): Promise<T & ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" } as T & ActionResult;
  try {
    requirePermission(ctx, permission);
    const svc = serviceCtxOf(ctx);
    const extra = await withTenant(ctx.tenant.id, (trx) => fn(trx, svc));
    revalidatePath("/purchasing");
    revalidatePath("/inventory");
    return { ok: true, ...extra } as T & ActionResult;
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as T & ActionResult;
    logger.error({ err: e }, "purchasing action failed");
    return { ok: false, errorKey: "errors.unexpected" } as T & ActionResult;
  }
}

const lineSchema = z.object({
  productId: z.string().uuid(),
  qtyBase: z.string(),
  unitCost: z.string(),
  batchNo: z.string().nullish(),
  expiryDate: z.string().nullish(),
});

export async function createPurchaseInvoiceAction(formData: FormData): Promise<ActionResult & { invoiceNo?: number }> {
  const linesJson = String(formData.get("linesJson") ?? "[]");
  const lines = z.array(lineSchema).min(1).safeParse(JSON.parse(linesJson));
  if (!lines.success) return { ok: false, errorKey: "errors.invoiceEmpty" };
  const input = {
    supplierId: String(formData.get("supplierId") ?? ""),
    supplierRef: String(formData.get("supplierRef") ?? "") || null,
    warehouseId: String(formData.get("warehouseId") ?? ""),
    businessDate: String(formData.get("businessDate") ?? todayBusinessDate()),
    dueDate: String(formData.get("dueDate") ?? "") || null,
    lines: lines.data,
  };
  return run<{ invoiceNo: number }>("purchasing.manage", async (trx, ctx) => {
    const id = await createPurchaseDraft(trx, ctx, input);
    const posted = await postPurchaseInvoice(trx, ctx, id);
    return { invoiceNo: posted.invoiceNo };
  });
}

export async function postPurchaseAction(formData: FormData): Promise<ActionResult & { invoiceNo?: number }> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  return run<{ invoiceNo: number }>("purchasing.manage", async (trx, ctx) => {
    const r = await postPurchaseInvoice(trx, ctx, invoiceId);
    return { invoiceNo: r.invoiceNo };
  });
}

const paymentSchema = z.object({
  supplierId: z.string().uuid(),
  method: z.enum(["cash", "bank_transfer", "card", "other"]),
  treasuryAccountId: z.string().uuid(),
  amount: z.string(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(400).nullish(),
  allocationsJson: z.string(),
});

export async function createSupplierPaymentAction(formData: FormData): Promise<ActionResult & { paymentNo?: number }> {
  const parsed = paymentSchema.safeParse({
    supplierId: formData.get("supplierId"),
    method: formData.get("method"),
    treasuryAccountId: formData.get("treasuryAccountId"),
    amount: formData.get("amount"),
    businessDate: formData.get("businessDate"),
    memo: formData.get("memo") || null,
    allocationsJson: formData.get("allocationsJson") ?? "[]",
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  const allocations = z
    .array(z.object({ purchaseInvoiceId: z.string().uuid(), amount: z.string() }))
    .safeParse(JSON.parse(parsed.data.allocationsJson || "[]"));
  if (!allocations.success) return { ok: false, errorKey: "errors.loginInvalidInput" };

  return run<{ paymentNo: number }>("purchasing.manage", async (trx, ctx) => {
    const r = await createSupplierPayment(trx, ctx, {
      ...parsed.data,
      allocations: allocations.data.map((a) => ({ ...a })),
      memo: parsed.data.memo ?? null,
    });
    return { paymentNo: r.paymentNo };
  });
}
