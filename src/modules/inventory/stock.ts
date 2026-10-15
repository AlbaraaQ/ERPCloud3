/**
 * StockLedgerService (D-006, D-008, D-009) — the ONLY writer of stock effects.
 * Guarantees: row-locked balance updates (INV-15), negative-stock prevention
 * by default, WAC per (warehouse, product), FEFO lot allocation for
 * expiry-tracked products, append-only ledger with source-idempotency (INV-05).
 */

import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  stockBalances,
  stockLedger,
  stockLots,
  products,
  warehouses,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { Decimal, dec, toDb } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";

export type MovementKind =
  | "receive"
  | "issue"
  | "transfer_out"
  | "transfer_in"
  | "adjustment_plus"
  | "adjustment_minus"
  | "return_in"
  | "return_out";

const OUT_KINDS: ReadonlySet<MovementKind> = new Set([
  "issue",
  "transfer_out",
  "adjustment_minus",
  "return_out",
]);

export interface MoveInput {
  warehouseId: string;
  productId: string;
  /** positive quantity in stock (base) unit */
  qty: string;
  movementType: MovementKind;
  /** required for incoming movements (receive/adjustment_plus/return_in) */
  unitCost?: string;
  businessDate: string;
  sourceType: string;
  sourceId: string;
  effectKind: string;
  lineRef?: string;
  memo?: string | null;
  /** lot info for receipts of lot-tracked products */
  lot?: { batchNo: string; expiryDate?: string | null };
  /**
   * INTERNAL: transfers bypass per-warehouse lot bookkeeping in Phase 2
   * (documented simplification; lot genealogy lands in Phase 5).
   */
  bypassLots?: boolean;
}

export interface MoveResult {
  ledgerId: string;
  onHand: string;
  avgCost: string;
  warehouseId: string;
  replayed: boolean;
  /** cost actually used for this movement (avg or FEFO lot cost) */
  unitCost: string;
  /** signed value posted to the ledger */
  value: string;
}

function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  while (cur && typeof cur === "object") {
    const c = (cur as { code?: string }).code;
    if (c) return c === "23505";
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function lockBalance(
  trx: Trx,
  tenantId: string,
  warehouseId: string,
  productId: string,
): Promise<{ onHand: Decimal; avgCost: Decimal }> {
  await trx
    .insert(stockBalances)
    .values({ tenantId, warehouseId, productId, onHand: "0", avgCost: "0" })
    .onConflictDoNothing();
  const rows = await trx.execute(sql`
    select on_hand, avg_cost from stock_balances
    where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and product_id = ${productId}
    for update
  `);
  const r = (rows as unknown as { rows: { on_hand: string; avg_cost: string }[] }).rows[0];
  return { onHand: dec(r.on_hand), avgCost: dec(r.avg_cost) };
}

async function saveBalance(
  trx: Trx,
  tenantId: string,
  warehouseId: string,
  productId: string,
  onHand: Decimal,
  avgCost: Decimal,
): Promise<void> {
  await trx
    .update(stockBalances)
    .set({ onHand: toDb(onHand), avgCost: avgCost.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(), updatedAt: new Date() })
    .where(
      and(
        eq(stockBalances.tenantId, tenantId),
        eq(stockBalances.warehouseId, warehouseId),
        eq(stockBalances.productId, productId),
      ),
    );
}

async function lotsFefo(
  trx: Trx,
  tenantId: string,
  productId: string,
  qty: Decimal,
): Promise<{ lotId: string; qty: Decimal; unitCost: Decimal }[] | null> {
  const rows = await trx.execute(sql`
    select id, qty_on_hand, unit_cost from stock_lots
    where tenant_id = ${tenantId} and product_id = ${productId} and qty_on_hand > 0
    order by (expiry_date is null), expiry_date asc nulls last, created_at asc
    for update
  `);
  const lots = (rows as unknown as { rows: { id: string; qty_on_hand: string; unit_cost: string }[] }).rows;
  const out: { lotId: string; qty: Decimal; unitCost: Decimal }[] = [];
  let remaining = qty;
  for (const l of lots) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, dec(l.qty_on_hand));
    if (take.gt(0)) {
      out.push({ lotId: l.id, qty: take, unitCost: dec(l.unit_cost) });
      remaining = remaining.minus(take);
    }
  }
  return remaining.lte(0) ? out : null;
}

/**
 * Record a stock movement atomically: balance row locked → policy checks →
 * balance update → ledger insert (idempotent by source keys).
 * For lot-tracked IN movements pass input.lot; for lot-tracked OUT movements
 * FEFO allocation is automatic (multiple ledger rows if several lots).
 */
export async function recordMovement(
  trx: Trx,
  ctx: ServiceCtx,
  input: MoveInput,
): Promise<MoveResult> {
  const qty = dec(input.qty);
  if (qty.lte(0)) throw errors.validation("errors.qtyMustBePositive");

  /**
   * Idempotency under PostgreSQL abort-on-error semantics: wrap the whole
   * movement in a savepoint. If the ledger unique key fires (retry / race),
   * roll back to the savepoint and report the original effect (INV-05).
   */
  // Idempotency pre-check: a fully committed earlier run of this op replays
  // without touching balances (the savepoint path below covers in-flight races).
  const [already] = await trx
    .select({ id: stockLedger.id, unitCost: stockLedger.unitCost, value: stockLedger.value })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.tenantId, ctx.tenantId),
        eq(stockLedger.sourceType, input.sourceType),
        eq(stockLedger.sourceId, input.sourceId),
        eq(stockLedger.effectKind, input.effectKind),
        eq(stockLedger.lineRef, input.lineRef ?? ""),
      ),
    )
    .limit(1);
  if (already) {
    const [bal] = await trx
      .select({ onHand: stockBalances.onHand, avgCost: stockBalances.avgCost })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.tenantId, ctx.tenantId),
          eq(stockBalances.warehouseId, input.warehouseId),
          eq(stockBalances.productId, input.productId),
        ),
      )
      .limit(1);
    return {
      ledgerId: already.id,
      onHand: bal?.onHand ?? "0",
      avgCost: bal?.avgCost ?? "0",
      warehouseId: input.warehouseId,
      replayed: true,
      unitCost: already.unitCost ?? "0",
      value: already.value ?? "0",
    };
  }

  const sp = `hisab_move_${newId().replace(/-/g, "").slice(0, 12)}`;
  await trx.execute(sql`savepoint ${sql.raw(sp)}`);
  try {
    return await recordMovementInner(trx, ctx, input, qty);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await trx.execute(sql`rollback to savepoint ${sql.raw(sp)}`);
    const [existing] = await trx
      .select({ id: stockLedger.id, unitCost: stockLedger.unitCost, value: stockLedger.value })
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.tenantId, ctx.tenantId),
          eq(stockLedger.sourceType, input.sourceType),
          eq(stockLedger.sourceId, input.sourceId),
          eq(stockLedger.effectKind, input.effectKind),
          eq(stockLedger.lineRef, input.lineRef ?? ""),
        ),
      )
      .limit(1);
    if (!existing) throw e;
    const [bal] = await trx
      .select({ onHand: stockBalances.onHand, avgCost: stockBalances.avgCost })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.tenantId, ctx.tenantId),
          eq(stockBalances.warehouseId, input.warehouseId),
          eq(stockBalances.productId, input.productId),
        ),
      )
      .limit(1);
    return {
      ledgerId: existing.id,
      onHand: bal?.onHand ?? "0",
      avgCost: bal?.avgCost ?? "0",
      warehouseId: input.warehouseId,
      replayed: true,
      unitCost: existing.unitCost ?? "0",
      value: existing.value ?? "0",
    };
  }
}

async function recordMovementInner(
  trx: Trx,
  ctx: ServiceCtx,
  input: MoveInput,
  qty: Decimal,
): Promise<MoveResult> {
  const [wh] = await trx
    .select({ allowNegative: warehouses.allowNegative, active: warehouses.active })
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.id, input.warehouseId)))
    .limit(1);
  if (!wh || !wh.active) throw errors.validation("errors.warehouseInvalid");

  const [product] = await trx
    .select({ trackLots: products.trackLots, active: products.active })
    .from(products)
    .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, input.productId)))
    .limit(1);
  if (!product || !product.active) throw errors.validation("errors.productInvalid");

  const isOut = OUT_KINDS.has(input.movementType);
  const bal = await lockBalance(trx, ctx.tenantId, input.warehouseId, input.productId);

  // ----- lot bookkeeping
  let issueAlloc: { lotId: string; qty: Decimal; unitCost: Decimal }[] | null = null;
  let lotId: string | null = null;

  const bypassLots = input.bypassLots === true;

  if (!isOut) {
    if (product.trackLots && !bypassLots) {
      if (!input.lot?.batchNo) throw errors.validation("errors.lotRequired");
      await trx
        .insert(stockLots)
        .values({
          id: newId(),
          tenantId: ctx.tenantId,
          productId: input.productId,
          batchNo: input.lot.batchNo,
          expiryDate: input.lot.expiryDate ?? null,
          unitCost: input.unitCost ?? "0",
          qtyOnHand: "0",
        })
        .onConflictDoNothing();
      await trx.execute(sql`
        update stock_lots set qty_on_hand = qty_on_hand + ${toDb(qty)}
        where tenant_id = ${ctx.tenantId} and product_id = ${input.productId} and batch_no = ${input.lot.batchNo}
      `);
      const [lot] = await trx
        .select({ id: stockLots.id })
        .from(stockLots)
        .where(and(eq(stockLots.tenantId, ctx.tenantId), eq(stockLots.productId, input.productId), eq(stockLots.batchNo, input.lot.batchNo)))
        .limit(1);
      lotId = lot.id;
    }
  } else if (product.trackLots && !bypassLots) {
    issueAlloc = await lotsFefo(trx, ctx.tenantId, input.productId, qty);
    if (!issueAlloc) {
      throw errors.validation("errors.insufficientStock", undefined, {
        productId: input.productId,
        reason: "lots",
      });
    }
    for (const a of issueAlloc) {
      await trx.execute(sql`
        update stock_lots set qty_on_hand = qty_on_hand - ${toDb(a.qty)}
        where id = ${a.lotId}
      `);
    }
  }

  // ----- quantity & valuation
  if (isOut && !wh.allowNegative && bal.onHand.lt(qty)) {
    throw errors.validation("errors.insufficientStock", undefined, {
      productId: input.productId,
      available: toDb(bal.onHand),
      requested: toDb(qty),
    });
  }

  const inCost = !isOut ? dec(input.unitCost ?? "0") : new Decimal(0);
  if (!isOut && inCost.isZero()) {
    // zero-cost guard (D-009); callers needing costless moves use specific flows
    throw errors.configuration("errors.zeroCostBlocked", undefined, { productId: input.productId });
  }

  let newOnHand: Decimal;
  let newAvg: Decimal;
  let ledgerCost: Decimal;
  let ledgerValue: Decimal;

  if (!isOut) {
    const totalValueBefore = bal.onHand.times(bal.avgCost);
    const added = qty.times(inCost);
    newOnHand = bal.onHand.plus(qty);
    newAvg = newOnHand.isZero()
      ? inCost
      : totalValueBefore.plus(added).div(newOnHand);
    ledgerCost = inCost;
    ledgerValue = added;
  } else {
    newOnHand = bal.onHand.minus(qty);
    if (issueAlloc) {
      ledgerValue = issueAlloc.reduce((acc, a) => acc.plus(a.qty.times(a.unitCost)), new Decimal(0));
      ledgerCost = ledgerValue.div(qty);
      newAvg = newOnHand.isZero()
        ? bal.avgCost
        : bal.onHand.times(bal.avgCost).minus(ledgerValue).div(newOnHand);
    } else {
      ledgerCost = bal.avgCost;
      ledgerValue = qty.times(ledgerCost);
      newAvg = bal.avgCost;
    }
  }

  await saveBalance(trx, ctx.tenantId, input.warehouseId, input.productId, newOnHand, newAvg);

  // ----- ledger insert (unique source keys; savepoint in the outer wrapper
  // converts a retry/race into a replay result without touching balances)
  const ledgerId = newId();
  {
    if (issueAlloc && issueAlloc.length > 1) {
      // one ledger row per lot for traceability (lineRef suffix per lot)
      for (const [i, a] of issueAlloc.entries()) {
        await trx.insert(stockLedger).values({
          id: newId(),
          tenantId: ctx.tenantId,
          productId: input.productId,
          warehouseId: input.warehouseId,
          lotId: a.lotId,
          movementType: input.movementType,
          qtyBase: toDb(a.qty.neg()),
          unitCost: toDb(a.unitCost),
          value: toDb(a.qty.times(a.unitCost).neg()),
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          effectKind: input.effectKind,
          lineRef: `${input.lineRef ?? ""}${input.lineRef ? ":" : ""}lot${i + 1}`,
          businessDate: input.businessDate,
          actorId: ctx.actorId,
          memo: input.memo ?? null,
        });
      }
    } else {
      await trx.insert(stockLedger).values({
        id: ledgerId,
        tenantId: ctx.tenantId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        lotId: issueAlloc ? issueAlloc[0].lotId : lotId,
        movementType: input.movementType,
        qtyBase: toDb(isOut ? qty.neg() : qty),
        unitCost: toDb(ledgerCost),
        value: toDb(isOut ? ledgerValue.neg() : ledgerValue),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        effectKind: input.effectKind,
        lineRef: input.lineRef ?? "",
        businessDate: input.businessDate,
        actorId: ctx.actorId,
        memo: input.memo ?? null,
      });
    }
  }

  return {
    ledgerId,
    onHand: toDb(newOnHand),
    avgCost: newAvg.toFixed(4),
    warehouseId: input.warehouseId,
    replayed: false,
    unitCost: toDb(ledgerCost),
    value: toDb(isOut ? ledgerValue.neg() : ledgerValue),
  };
}

/** Stock receipt (with audit). */
export async function receiveStock(
  trx: Trx,
  ctx: ServiceCtx,
  input: Omit<MoveInput, "movementType">,
): Promise<MoveResult> {
  const result = await recordMovement(trx, ctx, { ...input, movementType: "receive" });
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "inventory.stock.received",
    entity: "stock_movement",
    entityId: result.ledgerId,
    after: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      qty: input.qty,
      cost: input.unitCost,
      source: `${input.sourceType}/${input.sourceId}`,
    },
  });
  return result;
}

/** Ledger-derived reconciliation check (INV-06) for one product/warehouse. */
export async function ledgerVsBalance(
  trx: Trx,
  tenantId: string,
  warehouseId: string,
  productId: string,
): Promise<{ ledgerQty: Decimal; balanceQty: Decimal; matches: boolean }> {
  const res = await trx.execute(sql`
    select coalesce(sum(qty_base), 0)::text as "ledgerQty" from stock_ledger
    where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and product_id = ${productId}
  `);
  const ledgerQty = (res as unknown as { rows: { ledgerQty: string }[] }).rows[0]?.ledgerQty ?? "0";
  const [bal] = await trx
    .select({ onHand: stockBalances.onHand })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, tenantId),
        eq(stockBalances.warehouseId, warehouseId),
        eq(stockBalances.productId, productId),
      ),
    )
    .limit(1);
  const ledger = dec(ledgerQty);
  const balance = dec(bal?.onHand ?? 0);
  return { ledgerQty: ledger, balanceQty: balance, matches: ledger.eq(balance) };
}
