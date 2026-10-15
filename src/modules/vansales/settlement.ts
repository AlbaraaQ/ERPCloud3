/**
 * Settlement workflow (D-022, VAN_SALES_WORKFLOW §5).
 * requested → under_review → closed. Concurrency-safe via row lock; closed
 * settlements immutable (DB trigger). Discrepancies are exception-first:
 * approved adjustments only — never auto-debt, never auto-payroll.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  settlements,
  settlementLines,
  settlementExceptions,
  representatives,
  notifications,
  userRoles,
  roles,
  rolePermissions,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { Decimal, dec, toDb, roundMoney } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { recordMovement } from "@/modules/inventory/stock";
import { postEntry, nextDocNumber, type PostingLine } from "@/modules/accounting/posting";
import { resolveMany } from "@/modules/accounting/mappings";

type SettlementRow = typeof settlements.$inferSelect;

export interface ReconLine {
  productId: string;
  nameAr: string;
  expectedQty: string;
  countedQty: string | null;
  diffQty: string | null;
}

/** Unique open settlement per rep (idempotent request). */
export async function requestSettlement(
  trx: Trx,
  ctx: ServiceCtx,
  repUserId: string,
  businessDate: string,
): Promise<{ settlementId: string; settlementNo: number; replayed: boolean }> {
  const [rep] = await trx
    .select()
    .from(representatives)
    .where(and(eq(representatives.tenantId, ctx.tenantId), eq(representatives.userId, repUserId)))
    .limit(1);
  if (!rep || !rep.active) throw errors.validation("errors.notARepresentative");
  if (!rep.custodyWarehouseId) throw errors.configuration("errors.noCustodyWarehouse");

  // lock the representative row to serialize concurrent requests for same rep
  await trx
    .select({ id: representatives.id })
    .from(representatives)
    .where(eq(representatives.id, rep.id))
    .for("update");

  const [open] = await trx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.tenantId, ctx.tenantId),
        eq(settlements.repUserId, repUserId),
        eq(settlements.status, "requested"),
      ),
    )
    .limit(1);
  const [openReview] = await trx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.tenantId, ctx.tenantId),
        eq(settlements.repUserId, repUserId),
        eq(settlements.status, "under_review"),
      ),
    )
    .limit(1);
  const existing = open ?? openReview;
  if (existing) {
    return { settlementId: existing.id, settlementNo: existing.settlementNo!, replayed: true };
  }

  const settlementNo = await nextDocNumber(trx, ctx.tenantId, "SET");
  const id = newId();
  await trx.insert(settlements).values({
    id,
    tenantId: ctx.tenantId,
    settlementNo,
    repUserId,
    custodyWarehouseId: rep.custodyWarehouseId,
    businessDate,
    status: "requested",
    createdBy: ctx.actorId ?? repUserId,
  });

  // notify settlement reviewers (users holding settlement.review)
  const reviewers = await trx
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(
      and(
        eq(userRoles.tenantId, ctx.tenantId),
        eq(rolePermissions.permissionCode, "settlement.review"),
      ),
    );
  for (const r of reviewers) {
    if (r.userId === ctx.actorId) continue;
    await trx.insert(notifications).values({
      tenantId: ctx.tenantId,
      userId: r.userId,
      kind: "settlement.requested",
      title: "طلب تسوية جديد",
      body: `طلب تسوية رقم ${settlementNo} من مندوب. راجعه من شاشة التسويات.`,
      payload: { settlementId: id, settlementNo },
    });
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId ?? repUserId,
    actorLabel: ctx.actorId ?? "rep",
    action: "vansales.settlement.requested",
    entity: "settlement",
    entityId: id,
    after: { settlementNo, repUserId },
  });
  return { settlementId: id, settlementNo, replayed: false };
}

async function lockSettlement(trx: Trx, tenantId: string, settlementId: string): Promise<SettlementRow> {
  const [s] = await trx
    .select()
    .from(settlements)
    .where(and(eq(settlements.tenantId, tenantId), eq(settlements.id, settlementId)))
    .for("update")
    .limit(1);
  if (!s) throw errors.notFound("settlement", settlementId);
  return s;
}

/**
 * Open for review (accountant): computes the authoritative expected figures —
 * expected stock = custody balances; expected cash = rep cash receipts
 * (settled methods) − approved rep expenses; e-payment pendings surfaced.
 */
export async function openForReview(
  trx: Trx,
  ctx: ServiceCtx,
  settlementId: string,
): Promise<void> {
  const s = await lockSettlement(trx, ctx.tenantId, settlementId);
  if (s.status === "under_review") return;
  if (s.status !== "requested") throw errors.conflict("errors.settlementNotOpenable", settlementId, { status: s.status });

  // expected stock lines from custody balances
  const bals = await trx.execute(sql`
    select b.product_id, p.name_ar, b.on_hand::text
    from stock_balances b join products p on p.id = b.product_id
    where b.tenant_id = ${ctx.tenantId} and b.warehouse_id = ${s.custodyWarehouseId}
      and b.on_hand <> 0
    order by p.sku
  `);
  const lines = (bals as unknown as { rows: { product_id: string; name_ar: string; on_hand: string }[] }).rows;

  // expected cash: rep's settled cash/bank receipts − approved rep expenses
  const cash = await trx.execute(sql`
    select (
      coalesce((select sum(rl.amount) from receipt_lines rl
        join receipts r on r.id = rl.receipt_id
        where r.tenant_id = ${ctx.tenantId} and r.created_by = ${s.repUserId}
          and rl.method in ('cash', 'bank_transfer')), 0)
      - coalesce((select sum(e.amount) from expenses e
        where e.tenant_id = ${ctx.tenantId} and e.created_by = ${s.repUserId}
          and e.status = 'approved'), 0)
    )::text as expected
  `);
  const expectedCash = dec((cash as unknown as { rows: { expected: string }[] }).rows[0].expected);

  const pendingEpay = await trx.execute(sql`
    select coalesce(sum(rl.amount), 0)::text as amount, count(*)::text as cnt
    from receipt_lines rl
    join receipts r on r.id = rl.receipt_id
    where r.tenant_id = ${ctx.tenantId} and r.created_by = ${s.repUserId}
      and rl.settlement_status = 'pending'
  `);
  const epay = (pendingEpay as unknown as { rows: { amount: string; cnt: string }[] }).rows[0];

  await trx.delete(settlementLines).where(eq(settlementLines.settlementId, settlementId));
  if (lines.length > 0) {
    await trx.insert(settlementLines).values(
      lines.map((l) => ({
        id: newId(),
        tenantId: ctx.tenantId,
        settlementId,
        productId: l.product_id,
        expectedQty: l.on_hand,
      })),
    );
  }

  await trx
    .update(settlements)
    .set({
      status: "under_review",
      expectedCash: expectedCash.toFixed(4),
      snapshot: {
        expectedCash: expectedCash.toFixed(2),
        stockLines: lines.map((l) => ({ productId: l.product_id, nameAr: l.name_ar, expectedQty: l.on_hand })),
        pendingEpayments: { amount: epay.amount, count: Number(epay.cnt) },
      },
      reviewedBy: ctx.actorId,
      reviewedAt: new Date(),
    })
    .where(eq(settlements.id, settlementId));

  // surface pending e-payments as an info exception (must be resolved before close)
  if (Number(epay.cnt) > 0) {
    await trx.insert(settlementExceptions).values({
      id: newId(),
      tenantId: ctx.tenantId,
      settlementId,
      kind: "info",
      entity: "epayment",
      expected: dec(epay.amount).toFixed(4),
      actual: "0",
      diff: "0",
      note: `${epay.cnt} عملية دفع إلكتروني معلّقة التسوية بمبلغ ${Number(epay.amount).toFixed(2)}`,
      createdBy: ctx.actorId ?? "system",
    });
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "vansales.settlement.review_opened",
    entity: "settlement",
    entityId: settlementId,
    after: { expectedCash: expectedCash.toFixed(2), stockLines: lines.length },
  });
}

/** Record physical counts (cash + stock); diffs auto-create pending exceptions. */
export async function recordCounts(
  trx: Trx,
  ctx: ServiceCtx,
  settlementId: string,
  input: { countedCash: string; lines: { productId: string; countedQty: string }[] },
): Promise<void> {
  const s = await lockSettlement(trx, ctx.tenantId, settlementId);
  if (s.status !== "under_review") throw errors.validation("errors.settlementNotInReview");

  const countedCash = roundMoney(input.countedCash);
  const expectedCash = roundMoney(s.expectedCash ?? "0");
  const cashDiff = countedCash.minus(expectedCash);

  await trx
    .update(settlements)
    .set({ countedCash: countedCash.toFixed(4) })
    .where(eq(settlements.id, settlementId));

  for (const l of input.lines) {
    const [line] = await trx
      .select()
      .from(settlementLines)
      .where(and(eq(settlementLines.settlementId, settlementId), eq(settlementLines.productId, l.productId)))
      .limit(1);
    if (!line) throw errors.validation("errors.settlementLineInvalid", l.productId);
    const counted = dec(l.countedQty);
    const diff = counted.minus(dec(line.expectedQty));
    await trx
      .update(settlementLines)
      .set({ countedQty: counted.toFixed(6), diffQty: diff.toFixed(6) })
      .where(eq(settlementLines.id, line.id));
    if (!diff.isZero()) {
      await trx.insert(settlementExceptions).values({
        id: newId(),
        tenantId: ctx.tenantId,
        settlementId,
        kind: diff.isNegative() ? "shortage" : "overage",
        entity: "stock",
        productId: l.productId,
        expected: dec(line.expectedQty).toFixed(6),
        actual: counted.toFixed(6),
        diff: diff.toFixed(6),
        createdBy: ctx.actorId ?? "system",
      });
    }
  }

  if (!cashDiff.isZero()) {
    await trx.insert(settlementExceptions).values({
      id: newId(),
      tenantId: ctx.tenantId,
      settlementId,
      kind: cashDiff.isNegative() ? "shortage" : "overage",
      entity: "cash",
      expected: expectedCash.toFixed(4),
      actual: countedCash.toFixed(4),
      diff: cashDiff.toFixed(4),
      createdBy: ctx.actorId ?? "system",
    });
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "vansales.settlement.counts_recorded",
    entity: "settlement",
    entityId: settlementId,
    after: { countedCash: countedCash.toFixed(2), cashDiff: cashDiff.toFixed(2) },
  });
}

/** Approve a documented adjustment for an exception (explicit permission). */
export async function approveException(
  trx: Trx,
  ctx: ServiceCtx,
  exceptionId: string,
  note?: string,
): Promise<void> {
  const [e] = await trx
    .select()
    .from(settlementExceptions)
    .where(and(eq(settlementExceptions.tenantId, ctx.tenantId), eq(settlementExceptions.id, exceptionId)))
    .limit(1);
  if (!e) throw errors.notFound("settlementException", exceptionId);
  if (e.resolution !== "pending") return; // idempotent
  await trx
    .update(settlementExceptions)
    .set({
      resolution: "approved_adjustment",
      approvedBy: ctx.actorId,
      approvedAt: new Date(),
      note: note ? `${e.note ?? ""} — ${note}`.trim() : e.note,
    })
    .where(eq(settlementExceptions.id, exceptionId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "vansales.settlement.exception_approved",
    entity: "settlement_exception",
    entityId: exceptionId,
    after: { kind: e.kind, entity: e.entity, diff: e.diff },
  });
}

/**
 * Finalize (P-24…P-27): all exceptions must be resolved; postings happen in
 * one transaction; two concurrent finalizes → exactly one wins (row lock).
 */
export async function closeSettlement(
  trx: Trx,
  ctx: ServiceCtx,
  settlementId: string,
): Promise<{ replayed: boolean }> {
  const s = await lockSettlement(trx, ctx.tenantId, settlementId);
  if (s.status === "closed") return { replayed: true };
  if (s.status !== "under_review") throw errors.validation("errors.settlementNotInReview");

  const pending = await trx
    .select({ id: settlementExceptions.id })
    .from(settlementExceptions)
    .where(and(eq(settlementExceptions.settlementId, settlementId), eq(settlementExceptions.resolution, "pending")));
  if (pending.length > 0) {
    throw errors.validation("errors.settlementPendingExceptions", undefined, { count: pending.length });
  }

  const exceptions = await trx
    .select()
    .from(settlementExceptions)
    .where(eq(settlementExceptions.settlementId, settlementId));

  const mappings = await resolveMany(trx, ctx.tenantId, [
    "cash_default", "rep_cash_custody", "inventory_control", "settlement_inventory_adj",
  ]);
  const glLines: PostingLine[] = [];

  // cash handover (counted) → main cashbox (P-24)
  const handover = roundMoney(s.countedCash ?? "0");
  if (handover.gt(0)) {
    glLines.push({ accountId: mappings.cash_default, debit: handover.toFixed(2), credit: "0" });
    glLines.push({ accountId: mappings.rep_cash_custody, debit: "0", credit: handover.toFixed(2) });
  }

  // approved stock exceptions → adjustments + GL (P-25/26)
  let adjExpense = new Decimal(0);
  for (const e of exceptions) {
    if (e.entity !== "stock" || e.resolution !== "approved_adjustment" || !e.productId) continue;
    const diff = dec(e.diff ?? "0");
    if (diff.isZero()) continue;
    const isShortage = diff.isNegative();
    // overage cost: custody moving-average (zero-cost overages stay blocked — D-009)
    let adjCost: string | undefined;
    if (!isShortage) {
      const balRow = await trx.execute(sql`
        select avg_cost::text from stock_balances
        where tenant_id = ${ctx.tenantId} and warehouse_id = ${s.custodyWarehouseId} and product_id = ${e.productId}
      `);
      adjCost = (balRow as unknown as { rows: { avg_cost?: string }[] }).rows[0]?.avg_cost;
    }
    const mv = await recordMovement(trx, ctx, {
      warehouseId: s.custodyWarehouseId,
      productId: e.productId,
      qty: diff.abs().toFixed(6),
      movementType: isShortage ? "adjustment_minus" : "adjustment_plus",
      unitCost: adjCost,
      businessDate: s.businessDate,
      sourceType: "settlement",
      sourceId: settlementId,
      effectKind: `exc${e.id}`, // ≤ varchar(40) of stock_ledger.effect_kind
      lineRef: e.id,
      memo: "فرق تسوية معتمد",
    });
    const value = dec(mv.value ?? "0").abs();
    adjExpense = isShortage ? adjExpense.plus(value) : adjExpense.minus(value);
    await trx
      .update(settlementExceptions)
      .set({ journalEntryId: null })
      .where(eq(settlementExceptions.id, e.id));
  }

  if (!adjExpense.isZero()) {
    if (adjExpense.gt(0)) {
      glLines.push({ accountId: mappings.settlement_inventory_adj, debit: adjExpense.toFixed(2), credit: "0" });
      glLines.push({ accountId: mappings.inventory_control, debit: "0", credit: adjExpense.toFixed(2) });
    } else {
      const pos = adjExpense.abs();
      glLines.push({ accountId: mappings.inventory_control, debit: pos.toFixed(2), credit: "0" });
      glLines.push({ accountId: mappings.settlement_inventory_adj, debit: "0", credit: pos.toFixed(2) });
    }
  }

  if (glLines.length > 0) {
    const entry = await postEntry(
      trx,
      ctx,
      {
        sourceType: "settlement",
        sourceId: settlementId,
        effectKind: "post",
        businessDate: s.businessDate,
        memo: `تسوية مندوب ${s.settlementNo}`,
        lines: glLines,
      },
      "SAR",
    );
    // reference the entry on stock exceptions for traceability
    for (const e of exceptions) {
      if (e.entity === "stock" && e.resolution === "approved_adjustment") {
        await trx
          .update(settlementExceptions)
          .set({ journalEntryId: entry.id })
          .where(eq(settlementExceptions.id, e.id));
      }
    }
  }

  const [closed] = await trx
    .update(settlements)
    .set({ status: "closed", closedBy: ctx.actorId, closedAt: new Date() })
    .where(and(eq(settlements.id, settlementId), eq(settlements.status, "under_review")))
    .returning({ id: settlements.id });
  if (!closed) return { replayed: true };

  // notify the rep with final results (no other users' data)
  const hasExceptions = exceptions.length > 0;
  await trx.insert(notifications).values({
    tenantId: ctx.tenantId,
    userId: s.repUserId,
    kind: "settlement.closed",
    title: hasExceptions ? "أُقفل يومك بفروقات معتمدة" : "أُقفل يومك بنجاح",
    body: `التسوية ${s.settlementNo}: نقد مسلَّم ${handover.toFixed(2)}${hasExceptions ? ` مع ${exceptions.length} فروقات موثقة` : " بدون فروقات"}.`,
    payload: { settlementId, settlementNo: s.settlementNo },
  });

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "vansales.settlement.closed",
    entity: "settlement",
    entityId: settlementId,
    after: { handover: handover.toFixed(2), exceptions: exceptions.length },
  });
  return { replayed: false };
}
