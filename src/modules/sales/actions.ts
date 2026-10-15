"use server";

/** Sales server actions — POS save dialog (A/B) + receipts + returns. */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getSessionContext } from "@/modules/identity/auth";
import { db } from "@/db";
import { salesInvoices } from "@/db/schema";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { requirePermission, serviceCtxOf, hasPermission, type ServiceCtx } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { todayBusinessDate } from "@/modules/shared/dates";
import { newOpId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ActionResult } from "@/modules/shared/action-result";
import { createInvoiceDraft, postInvoice, createAndPostInvoice, createReturn } from "./invoices";
import { createReceiptCore, applyAdvance, settleReceiptLine } from "./receipts";

export interface InvoiceActionResult extends ActionResult {
  invoiceId?: string;
  invoiceNo?: number;
}

type Runner<T> = (trx: Trx, ctx: ServiceCtx) => Promise<T>;

async function run<T>(permission: string, fn: Runner<T>): Promise<T & ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" } as T & ActionResult;
  try {
    requirePermission(ctx, permission);
    const svc = serviceCtxOf(ctx);
    const extra = await withTenant(ctx.tenant.id, (trx) => fn(trx, svc));
    revalidatePath("/sales");
    revalidatePath("/pos");
    revalidatePath("/dashboard");
    return { ok: true, ...extra } as T & ActionResult;
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey } as T & ActionResult;
    logger.error({ err: e }, "sales action failed");
    return { ok: false, errorKey: "errors.unexpected" } as T & ActionResult;
  }
}

const paymentLine = z.object({
  method: z.enum(["cash", "bank_transfer", "card", "other"]),
  amount: z.string(),
  treasuryAccountId: z.string().uuid().nullish(),
  reference: z.string().nullish(),
});

const saveInvoiceSchema = z.object({
  customerId: z.string().uuid().nullable(),
  warehouseId: z.string().uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isCredit: z.boolean(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  clientOpId: z.string().uuid().nullish(),
  intent: z.enum(["draft", "post"]),
  linesJson: z.string(),
  paymentLinesJson: z.string().nullish(),
});

const lineSchema = z.object({
  productId: z.string().uuid(),
  qtyBase: z.string(),
  unitPrice: z.string().optional(),
  lineKind: z.enum(["normal", "free"]).optional(),
  discountAmount: z.string().optional(),
  overrideReason: z.string().optional(),
});

/** POS save dialog handler — Action A (post) / Action B (draft), IZ §5. */
export async function saveInvoiceAction(formData: FormData): Promise<InvoiceActionResult> {
  const parsed = saveInvoiceSchema.safeParse({
    customerId: formData.get("customerId") || null,
    warehouseId: formData.get("warehouseId"),
    businessDate: formData.get("businessDate"),
    isCredit: formData.get("isCredit") === "true",
    dueDate: formData.get("dueDate") || null,
    clientOpId: formData.get("clientOpId") || null,
    intent: formData.get("intent"),
    linesJson: formData.get("linesJson"),
    paymentLinesJson: formData.get("paymentLinesJson") || null,
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  const linesParsed = z.array(lineSchema).min(1).safeParse(JSON.parse(parsed.data.linesJson));
  if (!linesParsed.success) return { ok: false, errorKey: "errors.invoiceEmpty" };
  const paymentsParsed = parsed.data.paymentLinesJson
    ? z.array(paymentLine).safeParse(JSON.parse(parsed.data.paymentLinesJson))
    : { success: true as const, data: [] };
  if (!paymentsParsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };

  const d = parsed.data;
  const permission = d.intent === "post" ? "sales.invoice.post" : "sales.invoice.create";
  return run<{ invoiceId: string; invoiceNo?: number }>(permission, async (trx, ctx) => {
    const session = await getSessionContext();
    const canOverride = session ? hasPermission(session, "sales.price.override") : false;
    const input = {
      customerId: d.customerId,
      warehouseId: d.warehouseId,
      businessDate: d.businessDate,
      isCredit: d.isCredit,
      dueDate: d.dueDate ?? null,
      clientOpId: d.clientOpId ?? newOpId(),
      salespersonUserId: ctx.actorId,
      lines: linesParsed.data,
      paymentLines: paymentsParsed.data ?? [],
    };
    if (d.intent === "draft") {
      const invoiceId = await createInvoiceDraft(trx, ctx, input, canOverride);
      return { invoiceId };
    }
    const posted = await createAndPostInvoice(trx, ctx, input, canOverride);
    return { invoiceId: posted.invoiceId, invoiceNo: posted.invoiceNo };
  });
}

const receiptSchema = z.object({
  customerId: z.string().uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(400).nullish(),
  paymentLinesJson: z.string(),
  allocationsJson: z.string(),
});

export async function createReceiptAction(formData: FormData): Promise<ActionResult & { receiptNo?: number }> {
  const parsed = receiptSchema.safeParse({
    customerId: formData.get("customerId"),
    businessDate: formData.get("businessDate"),
    memo: formData.get("memo") || null,
    paymentLinesJson: formData.get("paymentLinesJson"),
    allocationsJson: formData.get("allocationsJson"),
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  const paymentLines = z.array(paymentLine).min(1).safeParse(JSON.parse(parsed.data.paymentLinesJson));
  const allocations = z
    .array(z.object({ invoiceId: z.string().uuid(), amount: z.string() }))
    .safeParse(JSON.parse(parsed.data.allocationsJson));
  if (!paymentLines.success || !allocations.success) return { ok: false, errorKey: "errors.loginInvalidInput" };

  return run<{ receiptNo: number }>("sales.receipts.manage", async (trx, ctx) => {
    const r = await createReceiptCore(trx, ctx, {
      customerId: parsed.data.customerId,
      businessDate: parsed.data.businessDate,
      memo: parsed.data.memo ?? null,
      paymentLines: paymentLines.data,
      allocations: allocations.data,
    });
    return { receiptNo: r.receiptNo };
  });
}

export async function applyAdvanceAction(formData: FormData): Promise<ActionResult> {
  const customerId = String(formData.get("customerId") ?? "");
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = String(formData.get("amount") ?? "0");
  return run("sales.receipts.manage", async (trx, ctx) => {
    await applyAdvance(trx, ctx, { customerId, invoiceId, amount, businessDate: todayBusinessDate() });
  });
}

export async function postDraftInvoiceAction(formData: FormData): Promise<InvoiceActionResult> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  return run<{ invoiceId: string; invoiceNo: number }>("sales.invoice.post", async (trx, ctx) => {
    const r = await postInvoice(trx, ctx, invoiceId, {});
    return { invoiceId, invoiceNo: r.invoiceNo };
  });
}

export async function deleteDraftInvoiceAction(formData: FormData): Promise<ActionResult> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  return run("sales.invoice.create", async (trx, ctx) => {
    const [inv] = await trx
      .select({ businessStatus: salesInvoices.businessStatus })
      .from(salesInvoices)
      .where(eq(salesInvoices.id, invoiceId))
      .for("update")
      .limit(1);
    if (inv && inv.businessStatus === "draft") {
      await trx.delete(salesInvoices).where(eq(salesInvoices.id, invoiceId));
      await writeAudit(trx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorId,
        actorLabel: ctx.actorId ?? "system",
        action: "sales.invoice.draft_deleted",
        entity: "sales_invoice",
        entityId: invoiceId,
      });
    }
  });
}

export async function createReturnAction(formData: FormData): Promise<InvoiceActionResult> {
  const originalInvoiceId = String(formData.get("originalInvoiceId") ?? "");
  const perLineQty = JSON.parse(String(formData.get("perLineQtyJson") ?? "{}")) as Record<string, string>;
  return run<{ invoiceId: string; invoiceNo: number }>("sales.return.create", async (trx, ctx) => {
    const r = await createReturn(trx, ctx, originalInvoiceId, perLineQty, todayBusinessDate());
    return { invoiceId: r.invoiceId, invoiceNo: r.invoiceNo };
  });
}

export async function settleReceiptLineAction(formData: FormData): Promise<ActionResult> {
  const receiptLineId = String(formData.get("receiptLineId") ?? "");
  return run("cash.manage", async (trx, ctx) => {
    await settleReceiptLine(trx, ctx, receiptLineId);
  });
}
