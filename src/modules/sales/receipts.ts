/**
 * Receipts & allocation engine (INV subledger — INV-08/09).
 * A receipt = payment method lines + allocations to open invoices + advance
 * remainder. Electronic payments carry a separate settlement state (FR-031).
 */

import { and, eq } from "drizzle-orm";
import {
  receipts,
  receiptLines,
  allocations,
  salesInvoices,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { Decimal, dec, roundMoney, toDb, sum } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { postEntry, nextDocNumber, type PostingLine } from "@/modules/accounting/posting";
import { resolveMany } from "@/modules/accounting/mappings";
import { sql } from "drizzle-orm";
import { advanceBalance, invoiceOutstanding } from "./balances";

export interface ReceiptPaymentLine {
  method: "cash" | "bank_transfer" | "card" | "other";
  amount: string;
  treasuryAccountId?: string | null;
  reference?: string | null;
}

export interface ReceiptInput {
  customerId: string;
  businessDate: string;
  paymentLines: ReceiptPaymentLine[];
  allocations: { invoiceId: string; amount: string }[];
  memo?: string | null;
}

const METHOD_GL_KEY: Record<string, string> = {
  cash: "cash_default",
  bank_transfer: "bank_default",
  card: "card_clearing",
  other: "bank_default",
};

/**
 * Core receipt writer. Runs inside a tenant transaction; used by the receipt
 * action AND invoice-at-post payment capture (single authoritative path).
 */
export async function createReceiptCore(
  trx: Trx,
  ctx: ServiceCtx,
  input: ReceiptInput,
): Promise<{ receiptId: string; receiptNo: number }> {
  if (input.paymentLines.length === 0) throw errors.validation("errors.receiptNoPayment");
  const total = roundMoney(sum(input.paymentLines.map((p) => p.amount)));
  if (total.lte(0)) throw errors.validation("errors.receiptZeroTotal");

  const allocTotal = roundMoney(sum(input.allocations.map((a) => a.amount)));
  if (allocTotal.gt(total)) {
    throw errors.validation("errors.allocExceedsReceipt", undefined, {
      total: total.toFixed(2),
      allocated: allocTotal.toFixed(2),
    });
  }

  // INV-09: per-invoice outstanding guard under row lock
  for (const a of input.allocations) {
    const amt = roundMoney(a.amount);
    if (amt.lte(0)) throw errors.validation("errors.qtyMustBePositive");
    await trx
      .select({ id: salesInvoices.id })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, a.invoiceId)))
      .for("update");
    const [inv] = await trx
      .select()
      .from(salesInvoices)
      .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, a.invoiceId)))
      .limit(1);
    if (!inv || inv.businessStatus !== "posted" || inv.invoiceType !== "sale") {
      throw errors.validation("errors.allocTargetInvalid", a.invoiceId);
    }
    const outstanding = await invoiceOutstanding(trx, ctx.tenantId, a.invoiceId);
    if (amt.gt(outstanding)) {
      throw errors.validation("errors.allocExceedsOutstanding", undefined, {
        invoiceId: a.invoiceId,
        outstanding: outstanding.toFixed(2),
        amount: amt.toFixed(2),
      });
    }
  }

  const receiptNo = await nextDocNumber(trx, ctx.tenantId, "RV");
  const id = newId();
  const advanceAmount = total.minus(allocTotal);

  await trx.insert(receipts).values({
    id,
    tenantId: ctx.tenantId,
    receiptNo,
    customerId: input.customerId,
    businessDate: input.businessDate,
    totalAmount: toDb(total),
    allocatedAmount: toDb(allocTotal),
    advanceAmount: toDb(advanceAmount.gt(0) ? advanceAmount : new Decimal(0)),
    memo: input.memo ?? null,
    status: "posted",
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });

  await trx.insert(receiptLines).values(
    input.paymentLines.map((p) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      receiptId: id,
      method: p.method,
      amount: toDb(roundMoney(p.amount)),
      treasuryAccountId: p.treasuryAccountId ?? null,
      reference: p.reference ?? null,
      settlementStatus: p.method === "card" ? ("pending" as const) : ("settled" as const),
      settledAt: p.method === "card" ? null : new Date(),
    })),
  );

  if (input.allocations.length > 0) {
    await trx.insert(allocations).values(
      input.allocations.map((a) => ({
        id: newId(),
        tenantId: ctx.tenantId,
        receiptId: id,
        invoiceId: a.invoiceId,
        amount: toDb(roundMoney(a.amount)),
        isAdvanceApplication: false,
        createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
      })),
    );
  }

  // GL: Dr treasury per method aggregate · Cr AR (allocated) · Cr advances
  const neededKeys = new Set<string>(["ar_control"]);
  if (advanceAmount.gt(0)) neededKeys.add("customer_advances");
  for (const p of input.paymentLines) neededKeys.add(METHOD_GL_KEY[p.method]);
  const mappings = await resolveMany(trx, ctx.tenantId, [...neededKeys]);

  const byMethod = new Map<string, Decimal>();
  for (const p of input.paymentLines) {
    byMethod.set(p.method, (byMethod.get(p.method) ?? new Decimal(0)).plus(dec(p.amount)));
  }
  const lines: PostingLine[] = [];
  for (const [method, amt] of byMethod) {
    lines.push({ accountId: mappings[METHOD_GL_KEY[method]], debit: toDb(roundMoney(amt)), credit: "0" });
  }
  if (allocTotal.gt(0)) lines.push({ accountId: mappings.ar_control, debit: "0", credit: toDb(allocTotal) });
  if (advanceAmount.gt(0)) {
    lines.push({ accountId: mappings.customer_advances!, debit: "0", credit: toDb(advanceAmount) });
  }

  await postEntry(
    trx,
    ctx,
    {
      sourceType: "receipt",
      sourceId: id,
      effectKind: "post",
      businessDate: input.businessDate,
      memo: `سند قبض ${receiptNo}`,
      lines,
    },
    "SAR",
  );

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "sales.receipt.posted",
    entity: "receipt",
    entityId: id,
    after: { receiptNo, total: toDb(total), allocated: toDb(allocTotal), advance: toDb(advanceAmount) },
  });
  return { receiptId: id, receiptNo };
}

/** Draw customer advance onto an open invoice (P-30; INV-09). */
export async function applyAdvance(
  trx: Trx,
  ctx: ServiceCtx,
  input: { customerId: string; invoiceId: string; amount: string; businessDate: string },
): Promise<void> {
  const amount = roundMoney(input.amount);
  if (amount.lte(0)) throw errors.validation("errors.qtyMustBePositive");

  const balance = await advanceBalance(trx, ctx.tenantId, input.customerId);
  if (amount.gt(balance)) {
    throw errors.validation("errors.advanceInsufficient", undefined, {
      available: balance.toFixed(2),
      requested: amount.toFixed(2),
    });
  }
  await trx
    .select({ id: salesInvoices.id })
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, input.invoiceId)))
    .for("update");
  const outstanding = await invoiceOutstanding(trx, ctx.tenantId, input.invoiceId);
  if (amount.gt(outstanding)) {
    throw errors.validation("errors.allocExceedsOutstanding", undefined, {
      outstanding: outstanding.toFixed(2),
      amount: amount.toFixed(2),
    });
  }

  const id = newId();
  await trx.insert(allocations).values({
    id,
    tenantId: ctx.tenantId,
    receiptId: null,
    invoiceId: input.invoiceId,
    amount: toDb(amount),
    isAdvanceApplication: true,
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });

  const mappings = await resolveMany(trx, ctx.tenantId, ["customer_advances", "ar_control"]);
  await postEntry(
    trx,
    ctx,
    {
      sourceType: "advance_application",
      sourceId: id,
      effectKind: "post",
      businessDate: input.businessDate,
      memo: "تخصيص دفعة مقدمة",
      lines: [
        { accountId: mappings.customer_advances, debit: toDb(amount), credit: "0" },
        { accountId: mappings.ar_control, debit: "0", credit: toDb(amount) },
      ],
    },
    "SAR",
  );

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "sales.advance.applied",
    entity: "allocation",
    entityId: id,
    after: { invoiceId: input.invoiceId, amount: toDb(amount) },
  });
}

/** Settle a pending electronic payment line (FR-031; audit + status only). */
export async function settleReceiptLine(
  trx: Trx,
  ctx: ServiceCtx,
  receiptLineId: string,
): Promise<void> {
  const [line] = await trx
    .select()
    .from(receiptLines)
    .where(and(eq(receiptLines.tenantId, ctx.tenantId), eq(receiptLines.id, receiptLineId)))
    .limit(1);
  if (!line) throw errors.notFound("receiptLine", receiptLineId);
  if (line.settlementStatus === "settled") return;
  await trx
    .update(receiptLines)
    .set({ settlementStatus: "settled", settledAt: new Date() })
    .where(eq(receiptLines.id, receiptLineId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "sales.payment.settled",
    entity: "receipt_line",
    entityId: receiptLineId,
    before: { settlementStatus: line.settlementStatus },
    after: { settlementStatus: "settled" },
  });
}
