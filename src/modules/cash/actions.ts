"use server";

/** Cash & expenses server actions. */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { requirePermission, serviceCtxOf, type ServiceCtx } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { todayBusinessDate } from "@/modules/shared/dates";
import type { ActionResult } from "@/modules/shared/action-result";
import { createExpense, approveExpense, rejectExpense } from "./expenses";
import { settleReceiptLine } from "@/modules/sales/receipts";

type Runner = (trx: Trx, ctx: ServiceCtx) => Promise<void>;

async function run(permission: string, fn: Runner): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  try {
    requirePermission(ctx, permission);
    const svc = serviceCtxOf(ctx);
    await withTenant(ctx.tenant.id, (trx) => fn(trx, svc));
    revalidatePath("/cash");
    return { ok: true };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey };
    logger.error({ err: e }, "cash action failed");
    return { ok: false, errorKey: "errors.unexpected" };
  }
}

const expenseSchema = z.object({
  category: z.string().min(2).max(80),
  amount: z.string(),
  method: z.enum(["cash", "bank_transfer", "card", "other"]),
  treasuryAccountId: z.string().uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(400).nullish(),
});

export async function createExpenseAction(formData: FormData): Promise<ActionResult> {
  const parsed = expenseSchema.safeParse({
    category: formData.get("category"),
    amount: formData.get("amount"),
    method: formData.get("method") || "cash",
    treasuryAccountId: formData.get("treasuryAccountId"),
    businessDate: formData.get("businessDate") || todayBusinessDate(),
    note: formData.get("note") || null,
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  return run("expenses.create", async (trx, ctx) => {
    await createExpense(trx, ctx, { ...parsed.data, businessDate: parsed.data.businessDate ?? todayBusinessDate(), note: parsed.data.note ?? null });
  });
}

export async function approveExpenseAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("expenseId") ?? "");
  return run("expenses.approve", async (trx, ctx) => {
    await approveExpense(trx, ctx, id);
  });
}

export async function rejectExpenseAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("expenseId") ?? "");
  const reason = String(formData.get("reason") ?? "مرفوض");
  return run("expenses.approve", async (trx, ctx) => {
    await rejectExpense(trx, ctx, id, reason);
  });
}

export async function settleCardAction(formData: FormData): Promise<ActionResult> {
  const receiptLineId = String(formData.get("receiptLineId") ?? "");
  return run("cash.manage", async (trx, ctx) => {
    await settleReceiptLine(trx, ctx, receiptLineId);
  });
}
