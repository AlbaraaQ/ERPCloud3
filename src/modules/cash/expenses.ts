/**
 * Expenses (FR-043): created as pending (no GL), post only when approved.
 * Rejection keeps the record + audit (never silently deleted).
 */

import { and, eq } from "drizzle-orm";
import { expenses } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { dec, toDb } from "@/modules/shared/money";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { newId } from "@/modules/shared/ids";
import { postEntry, nextDocNumber } from "@/modules/accounting/posting";
import { resolveMappingId } from "@/modules/accounting/mappings";

export async function createExpense(
  trx: Trx,
  ctx: ServiceCtx,
  input: {
    category: string;
    amount: string;
    method: "cash" | "bank_transfer" | "card" | "other";
    treasuryAccountId: string;
    businessDate: string;
    note?: string | null;
  },
): Promise<string> {
  const amount = dec(input.amount);
  if (amount.lte(0)) throw errors.validation("errors.receiptZeroTotal");
  const id = newId();
  await trx.insert(expenses).values({
    id,
    tenantId: ctx.tenantId,
    category: input.category,
    amount: toDb(amount),
    method: input.method,
    treasuryAccountId: input.treasuryAccountId,
    businessDate: input.businessDate,
    note: input.note ?? null,
    status: "pending",
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "cash.expense.created",
    entity: "expense",
    entityId: id,
    after: { category: input.category, amount: toDb(amount) },
  });
  return id;
}

/** Approve → post GL (P-23) — requires expenses.approve at action layer. */
export async function approveExpense(
  trx: Trx,
  ctx: ServiceCtx,
  expenseId: string,
): Promise<void> {
  const [exp] = await trx
    .select()
    .from(expenses)
    .where(and(eq(expenses.tenantId, ctx.tenantId), eq(expenses.id, expenseId)))
    .for("update")
    .limit(1);
  if (!exp) throw errors.notFound("expense", expenseId);
  if (exp.status === "approved") return; // idempotent
  if (exp.status === "rejected") throw errors.validation("errors.expenseRejected");

  const expenseAcct = await resolveMappingId(trx, ctx.tenantId, "expense_default");
  const glKey = exp.method === "cash" ? "cash_default" : "bank_default";
  const glAcct = await resolveMappingId(trx, ctx.tenantId, glKey);
  const posted = await postEntry(
    trx,
    ctx,
    {
      sourceType: "expense",
      sourceId: expenseId,
      effectKind: "post",
      businessDate: exp.businessDate,
      memo: `مصروف — ${exp.category}${exp.note ? `: ${exp.note}` : ""}`,
      lines: [
        { accountId: expenseAcct, debit: exp.amount, credit: "0" },
        { accountId: glAcct, debit: "0", credit: exp.amount },
      ],
    },
    "SAR",
  );

  const expenseNo = await nextDocNumber(trx, ctx.tenantId, "EX");
  await trx
    .update(expenses)
    .set({
      status: "approved",
      approvedBy: ctx.actorId,
      approvedAt: new Date(),
      expenseNo,
      journalEntryId: posted.id,
    })
    .where(eq(expenses.id, expenseId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "cash.expense.approved",
    entity: "expense",
    entityId: expenseId,
    after: { expenseNo, journal: posted.id },
  });
}

export async function rejectExpense(trx: Trx, ctx: ServiceCtx, expenseId: string, reason: string): Promise<void> {
  const [exp] = await trx
    .select()
    .from(expenses)
    .where(and(eq(expenses.tenantId, ctx.tenantId), eq(expenses.id, expenseId)))
    .for("update")
    .limit(1);
  if (!exp) throw errors.notFound("expense", expenseId);
  if (exp.status !== "pending") throw errors.validation("errors.expenseNotPending");
  await trx.update(expenses).set({ status: "rejected", note: reason }).where(eq(expenses.id, expenseId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "cash.expense.rejected",
    entity: "expense",
    entityId: expenseId,
    after: { reason },
  });
}
