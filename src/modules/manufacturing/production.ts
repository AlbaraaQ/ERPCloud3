/**
 * Manufacturing engine (FR-024…028, D-009).
 * Lifecycle: planned → in_progress → completed. Consumption posts at ACTUAL
 * issue cost (FEFO for lot-tracked), output receives at computed unit cost —
 * (consumption + labor/overhead) / actual output. Missing cost inputs block
 * posting with a configuration error; zero-cost production never posts.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  boms,
  bomLines,
  productionOrders,
  productionConsumptions,
  productionOutputs,
  productionCostComponents,
  products,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { Decimal, dec, roundMoney, toDb, sum } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { recordMovement } from "@/modules/inventory/stock";
import { postEntry, nextDocNumber, type PostingLine } from "@/modules/accounting/posting";
import { resolveMany } from "@/modules/accounting/mappings";

/* ------------------------------------------------------------------ BOM ---- */
export async function createBom(
  trx: Trx,
  ctx: ServiceCtx,
  input: {
    productId: string;
    name: string;
    yieldQty: string;
    notes?: string | null;
    lines: { productId: string; qty: string }[];
  },
): Promise<string> {
  if (input.lines.length === 0) throw errors.validation("errors.bomEmpty");
  const yieldQty = dec(input.yieldQty);
  if (yieldQty.lte(0)) throw errors.validation("errors.qtyMustBePositive");
  for (const [i, l] of input.lines.entries()) {
    if (dec(l.qty).lte(0)) throw errors.validation("errors.qtyMustBePositive", undefined, { line: i + 1 });
    if (l.productId === input.productId) throw errors.validation("errors.bomSelfReference");
    const [p] = await trx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, l.productId)))
      .limit(1);
    if (!p) throw errors.validation("errors.productInvalid", l.productId, { line: i + 1 });
  }

  const [prev] = await trx
    .select({ version: boms.version })
    .from(boms)
    .where(and(eq(boms.tenantId, ctx.tenantId), eq(boms.productId, input.productId)))
    .orderBy(desc(boms.version))
    .limit(1);
  const version = (prev?.version ?? 0) + 1;
  // deactivate prior versions of the same product
  await trx
    .update(boms)
    .set({ active: false })
    .where(and(eq(boms.tenantId, ctx.tenantId), eq(boms.productId, input.productId)));

  const id = newId();
  await trx.insert(boms).values({
    id,
    tenantId: ctx.tenantId,
    productId: input.productId,
    version,
    name: input.name,
    yieldQty: toDb(yieldQty),
    notes: input.notes ?? null,
    active: true,
  });
  await trx.insert(bomLines).values(
    input.lines.map((l, i) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      bomId: id,
      lineNo: i + 1,
      productId: l.productId,
      qty: toDb(dec(l.qty)),
    })),
  );
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "mfg.bom.created",
    entity: "bom",
    entityId: id,
    after: { productId: input.productId, version, lines: input.lines.length },
  });
  return id;
}

/* --------------------------------------------------------------- orders ---- */
export async function createProductionOrder(
  trx: Trx,
  ctx: ServiceCtx,
  input: {
    bomId: string;
    plannedQty: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    businessDate: string;
  },
): Promise<string> {
  const planned = dec(input.plannedQty);
  if (planned.lte(0)) throw errors.validation("errors.qtyMustBePositive");
  const [bom] = await trx
    .select()
    .from(boms)
    .where(and(eq(boms.tenantId, ctx.tenantId), eq(boms.id, input.bomId)))
    .limit(1);
  // Orders may reference any existing BOM version (older versions remain
  // valid for their orders; `active` only governs the default for NEW ones).
  if (!bom) throw errors.validation("errors.bomInvalid");
  const id = newId();
  await trx.insert(productionOrders).values({
    id,
    tenantId: ctx.tenantId,
    bomId: input.bomId,
    productId: bom.productId,
    plannedQty: toDb(planned),
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    businessDate: input.businessDate,
    status: "planned",
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "mfg.order.created",
    entity: "production_order",
    entityId: id,
    after: { bomId: input.bomId, plannedQty: toDb(planned) },
  });
  return id;
}

async function lockOrder(trx: Trx, tenantId: string, orderId: string) {
  const [o] = await trx
    .select()
    .from(productionOrders)
    .where(and(eq(productionOrders.tenantId, tenantId), eq(productionOrders.id, orderId)))
    .for("update")
    .limit(1);
  if (!o) throw errors.notFound("productionOrder", orderId);
  return o;
}

/**
 * Start production: consume BOM materials at ACTUAL issue cost.
 * actualOverrides: { bomLineId: qty } — planned defaults to BOM-scaled qty.
 * GL P-17: Dr Production clearing · Cr Raw inventory (one entry).
 */
export async function startProduction(
  trx: Trx,
  ctx: ServiceCtx,
  orderId: string,
  actualOverrides: Record<string, string> = {},
): Promise<void> {
  const order = await lockOrder(trx, ctx.tenantId, orderId);
  if (order.status === "in_progress") return; // idempotent
  if (order.status !== "planned") throw errors.conflict("errors.productionStateInvalid", orderId, { status: order.status });

  const [bom] = await trx.select().from(boms).where(eq(boms.id, order.bomId)).limit(1);
  const lines = await trx.select().from(bomLines).where(eq(bomLines.bomId, order.bomId));
  if (lines.length === 0) throw errors.configuration("errors.bomEmpty");

  const batches = dec(order.plannedQty).div(dec(bom!.yieldQty));
  const orderNo = await nextDocNumber(trx, ctx.tenantId, "PR");

  let totalValue = new Decimal(0);
  for (const l of lines) {
    const planned = batches.times(dec(l.qty));
    const actual = actualOverrides[l.id] !== undefined ? dec(actualOverrides[l.id]) : planned;
    if (actual.lte(0)) throw errors.validation("errors.qtyMustBePositive", l.productId);
    const mv = await recordMovement(trx, ctx, {
      warehouseId: order.fromWarehouseId,
      productId: l.productId,
      qty: toDb(actual),
      movementType: "issue",
      businessDate: order.businessDate,
      sourceType: "production",
      sourceId: orderId,
      effectKind: "consume",
      lineRef: l.id,
      memo: "استهلاك إنتاج",
    });
    const value = dec(mv.value).abs();
    totalValue = totalValue.plus(value);
    await trx.insert(productionConsumptions).values({
      id: newId(),
      tenantId: ctx.tenantId,
      orderId,
      bomLineId: l.id,
      productId: l.productId,
      plannedQty: toDb(planned),
      actualQty: toDb(actual),
      costValue: toDb(value),
    });
  }

  const mappings = await resolveMany(trx, ctx.tenantId, ["production_clearing", "inventory_control"]);
  await postEntry(
    trx,
    ctx,
    {
      sourceType: "production",
      sourceId: orderId,
      effectKind: "consume",
      businessDate: order.businessDate,
      memo: `استهلاك أمر إنتاج ${orderNo}`,
      lines: [
        { accountId: mappings.production_clearing, debit: toDb(roundMoney(totalValue)), credit: "0" },
        { accountId: mappings.inventory_control, debit: "0", credit: toDb(roundMoney(totalValue)) },
      ],
    },
    "SAR",
  );

  await trx
    .update(productionOrders)
    .set({ status: "in_progress", orderNo, startedAt: new Date() })
    .where(eq(productionOrders.id, orderId));

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "mfg.order.started",
    entity: "production_order",
    entityId: orderId,
    after: { orderNo, consumptionValue: totalValue.toFixed(2) },
  });
}

/** Add a cost component (labor/overhead). GL P-19: Dr clearing · Cr accrued. */
export async function addCostComponent(
  trx: Trx,
  ctx: ServiceCtx,
  orderId: string,
  input: { kind: "labor" | "overhead" | "other"; description: string; amount: string },
): Promise<void> {
  const order = await lockOrder(trx, ctx.tenantId, orderId);
  if (order.status !== "in_progress") throw errors.validation("errors.productionNotInProgress");
  const amount = roundMoney(input.amount);
  if (amount.lte(0)) throw errors.validation("errors.qtyMustBePositive");

  const mappings = await resolveMany(trx, ctx.tenantId, ["production_clearing", "accrued_expenses"]);
  const entry = await postEntry(
    trx,
    ctx,
    {
      sourceType: "production_component",
      sourceId: orderId,
      effectKind: `comp_${input.kind}`,
      businessDate: order.businessDate,
      memo: `مكوّن تكلفة (${input.kind}) — أمر إنتاج ${order.orderNo ?? ""}`,
      lines: [
        { accountId: mappings.production_clearing, debit: toDb(amount), credit: "0" },
        { accountId: mappings.accrued_expenses, debit: "0", credit: toDb(amount) },
      ],
    },
    "SAR",
  );
  await trx.insert(productionCostComponents).values({
    id: newId(),
    tenantId: ctx.tenantId,
    orderId,
    kind: input.kind,
    description: input.description,
    amount: toDb(amount),
    journalEntryId: entry.id,
  });
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "mfg.order.component_added",
    entity: "production_order",
    entityId: orderId,
    after: { kind: input.kind, amount: toDb(amount) },
  });
}

/**
 * Scrap (normal vs abnormal — P-20/21). Removes value from the clearing pool
 * so it is never silently absorbed nor double-counted into unit cost.
 */
export async function recordScrap(
  trx: Trx,
  ctx: ServiceCtx,
  orderId: string,
  input: { productId: string; qty: string; abnormal?: boolean; note?: string },
): Promise<void> {
  const order = await lockOrder(trx, ctx.tenantId, orderId);
  if (order.status !== "in_progress") throw errors.validation("errors.productionNotInProgress");
  const qty = dec(input.qty);
  if (qty.lte(0)) throw errors.validation("errors.qtyMustBePositive");

  // random-tail suffix — uuidv7's time prefix collides for sequential scraps
  const keySuffix = newId().replace(/-/g, "").slice(-12);
  const mv = await recordMovement(trx, ctx, {
    warehouseId: order.fromWarehouseId,
    productId: input.productId,
    qty: toDb(qty),
    movementType: "issue",
    businessDate: order.businessDate,
    sourceType: "production_scrap",
    sourceId: orderId,
    effectKind: `scrap_${keySuffix}`,
    memo: input.note ?? "هالك إنتاج",
  });
  const value = roundMoney(dec(mv.value).abs());
  const key = input.abnormal ? "abnormal_loss" : "scrap_expense";
  const mappings = await resolveMany(trx, ctx.tenantId, ["production_clearing", key]);
  await postEntry(
    trx,
    ctx,
    {
      sourceType: "production_scrap",
      sourceId: orderId,
      effectKind: `scrapgl_${keySuffix}`,
      businessDate: order.businessDate,
      memo: `هالك إنتاج ${order.orderNo ?? ""} (${input.abnormal ? "غير طبيعي" : "طبيعي"})`,
      lines: [
        { accountId: mappings[key], debit: toDb(value), credit: "0" },
        { accountId: mappings.production_clearing, debit: "0", credit: toDb(value) },
      ],
    },
    "SAR",
  );
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: input.abnormal ? "mfg.order.scrap_abnormal" : "mfg.order.scrap_normal",
    entity: "production_order",
    entityId: orderId,
    after: { productId: input.productId, qty: toDb(qty), value: toDb(value) },
  });
}

/**
 * Complete production: receive finished goods at computed unit cost.
 * unitCost = (consumption + components − scrap removed) / actual output qty.
 * Zero/negative cost basis → blocked with configuration error (D-009/FR-028).
 */
export async function completeProduction(
  trx: Trx,
  ctx: ServiceCtx,
  orderId: string,
  input: { outputQty: string; expiryDate?: string | null },
): Promise<{ unitCost: string; lotId: string | null }> {
  const order = await lockOrder(trx, ctx.tenantId, orderId);
  if (order.status === "completed") {
    const [out] = await trx.select().from(productionOutputs).where(eq(productionOutputs.orderId, orderId)).limit(1);
    return { unitCost: out?.unitCost ?? "0", lotId: out?.lotId ?? null };
  }
  if (order.status !== "in_progress") throw errors.validation("errors.productionNotInProgress");

  const outputQty = dec(input.outputQty);
  if (outputQty.lte(0)) throw errors.validation("errors.qtyMustBePositive");

  const consumptions = await trx
    .select({ costValue: productionConsumptions.costValue })
    .from(productionConsumptions)
    .where(eq(productionConsumptions.orderId, orderId));
  const components = await trx
    .select({ amount: productionCostComponents.amount })
    .from(productionCostComponents)
    .where(eq(productionCostComponents.orderId, orderId));

  const consumptionValue = sum(consumptions.map((c) => c.costValue));
  const componentsValue = sum(components.map((c) => c.amount));

  // clearing basis tracked by the GL: consumption + components − scrap
  const clearingGl = await trx.execute(sql`
    select coalesce(sum(l.debit::numeric - l.credit::numeric), 0)::text as balance
    from journal_lines l
    join accounts a on a.id = l.account_id
    join journal_entries e on e.id = l.entry_id
    where a.code = '5201' and l.tenant_id = ${ctx.tenantId}
      and ((e.source_type = 'production' and e.source_id = ${orderId})
        or (e.source_type = 'production_component' and e.source_id = ${orderId})
        or (e.source_type = 'production_scrap' and e.source_id = ${orderId}))
  `);
  const basis = dec((clearingGl as unknown as { rows: { balance: string }[] }).rows[0].balance);
  if (basis.lte(0)) {
    throw errors.configuration("errors.productionCostMissing", undefined, {
      orderId,
      detail: "no consumption/components cost basis",
    });
  }
  if (components.length === 0 && consumptions.length === 0) {
    throw errors.configuration("errors.productionCostMissing", orderId);
  }

  const unitCost = basis.div(outputQty);
  if (unitCost.lte(0)) throw errors.invariant("computed unit cost ≤ 0", { orderId });

  const [product] = await trx
    .select({ trackLots: products.trackLots, trackExpiry: products.trackExpiry })
    .from(products)
    .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, order.productId)))
    .limit(1);
  if (!product) throw errors.validation("errors.productInvalid");

  const batchNo = `PR-${order.orderNo ?? orderId.slice(0, 8)}`;
  if (product.trackLots && product.trackExpiry && !input.expiryDate) {
    throw errors.validation("errors.expiryRequired", undefined, { productId: order.productId });
  }

  const mv = await recordMovement(trx, ctx, {
    warehouseId: order.toWarehouseId,
    productId: order.productId,
    qty: toDb(outputQty),
    movementType: "receive",
    unitCost: unitCost.toFixed(4),
    lot: product.trackLots ? { batchNo, expiryDate: input.expiryDate ?? null } : undefined,
    businessDate: order.businessDate,
    sourceType: "production",
    sourceId: orderId,
    effectKind: "output",
    memo: "استلام منتج تام",
  });

  // finished-goods lot for genealogy
  let lotId: string | null = null;
  if (product.trackLots) {
    const lotRes = await trx.execute(sql`
      select id from stock_lots where tenant_id = ${ctx.tenantId} and product_id = ${order.productId} and batch_no = ${batchNo}
    `);
    lotId = (lotRes as unknown as { rows: { id: string }[] }).rows[0]?.id ?? null;
  }

  await trx.insert(productionOutputs).values({
    id: newId(),
    tenantId: ctx.tenantId,
    orderId,
    productId: order.productId,
    qty: toDb(outputQty),
    unitCost: unitCost.toFixed(4),
    lotId,
  });

  // GL P-18: Dr Finished inventory · Cr Production clearing (exact clearing balance)
  const mappings = await resolveMany(trx, ctx.tenantId, ["production_clearing", "inventory_control"]);
  await postEntry(
    trx,
    ctx,
    {
      sourceType: "production",
      sourceId: orderId,
      effectKind: "output",
      businessDate: order.businessDate,
      memo: `إخراج أمر إنتاج ${order.orderNo ?? ""}`,
      lines: [
        { accountId: mappings.inventory_control, debit: basis.toFixed(2), credit: "0" },
        { accountId: mappings.production_clearing, debit: "0", credit: basis.toFixed(2) },
      ],
    },
    "SAR",
  );

  await trx
    .update(productionOrders)
    .set({ status: "completed", outputQty: toDb(outputQty), completedAt: new Date() })
    .where(eq(productionOrders.id, orderId));

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "mfg.order.completed",
    entity: "production_order",
    entityId: orderId,
    after: { outputQty: toDb(outputQty), unitCost: unitCost.toFixed(4), basis: basis.toFixed(2), lotId },
  });
  return { unitCost: unitCost.toFixed(4), lotId };
}

/** Cancel a planned order (no effects posted yet). */
export async function cancelProductionOrder(trx: Trx, ctx: ServiceCtx, orderId: string): Promise<void> {
  const order = await lockOrder(trx, ctx.tenantId, orderId);
  if (order.status !== "planned") throw errors.validation("errors.productionNotCancellable");
  await trx.update(productionOrders).set({ status: "cancelled" }).where(eq(productionOrders.id, orderId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "mfg.order.cancelled",
    entity: "production_order",
    entityId: orderId,
  });
}

/**
 * Recall genealogy (FR-027): trace a finished-goods lot back to its consumed
 * material lots, and forward to sales that issued it.
 */
export async function traceRecall(
  trx: Trx,
  tenantId: string,
  lotId: string,
): Promise<{
  output: Record<string, unknown> | null;
  order: Record<string, unknown> | null;
  consumedLots: Record<string, unknown>[];
  sales: Record<string, unknown>[];
}> {
  const output = await trx.execute(sql`
    select o.id as output_id, o.order_id, o.qty::text, o.unit_cost::text, p.name_ar as product_name, l.batch_no
    from production_outputs o
    join products p on p.id = o.product_id
    join stock_lots l on l.id = o.lot_id
    where o.tenant_id = ${tenantId} and o.lot_id = ${lotId}
  `);
  const out = (output as unknown as { rows: Record<string, unknown>[] }).rows[0] ?? null;

  let order: Record<string, unknown> | null = null;
  let consumed: Record<string, unknown>[] = [];
  if (out) {
    const o = await trx.execute(sql`
      select order_no::text, planned_qty::text, output_qty::text, business_date, status
      from production_orders where id = ${out.order_id as string}
    `);
    order = (o as unknown as { rows: Record<string, unknown>[] }).rows[0] ?? null;
    const c = await trx.execute(sql`
      select distinct l.id as lot_id, l.batch_no, l.expiry_date, p.name_ar as product_name,
             sum(sl.qty_base)::text as qty
      from stock_ledger sl
      join stock_lots l on l.id = sl.lot_id
      join products p on p.id = sl.product_id
      where sl.tenant_id = ${tenantId} and sl.source_type = 'production'
        and sl.source_id = ${out.order_id as string} and sl.effect_kind = 'consume' and sl.lot_id is not null
      group by l.id, l.batch_no, l.expiry_date, p.name_ar
    `);
    consumed = (c as unknown as { rows: Record<string, unknown>[] }).rows;
  }

  const sales = await trx.execute(sql`
    select i.invoice_no::text invoice_no, i.business_date, c.name_ar as customer_name,
           sl.qty_base::text as qty
    from stock_ledger sl
    join sales_invoices i on i.id::text = sl.source_id::text
    left join customers c on c.id = i.customer_id
    where sl.tenant_id = ${tenantId} and sl.lot_id = ${lotId}
      and sl.source_type = 'sales_invoice' and sl.movement_type = 'issue'
  `);
  return { output: out, order, consumedLots: consumed, sales: (sales as unknown as { rows: Record<string, unknown>[] }).rows };
}

/** Yield/variance view per order. */
export async function orderVariance(trx: Trx, tenantId: string, orderId: string) {
  const [order] = await trx
    .select()
    .from(productionOrders)
    .where(and(eq(productionOrders.tenantId, tenantId), eq(productionOrders.id, orderId)))
    .limit(1);
  if (!order) throw errors.notFound("productionOrder", orderId);
  const consumptions = await trx
    .select()
    .from(productionConsumptions)
    .where(eq(productionConsumptions.orderId, orderId));
  const components = await trx
    .select()
    .from(productionCostComponents)
    .where(eq(productionCostComponents.orderId, orderId));
  const matActual = sum(consumptions.map((c) => c.costValue));
  const matPlannedQty = sum(consumptions.map((c) => c.plannedQty));
  const matActualQty = sum(consumptions.map((c) => c.actualQty));
  const compValue = sum(components.map((c) => c.amount));
  const [out] = await trx.select().from(productionOutputs).where(eq(productionOutputs.orderId, orderId)).limit(1);
  return {
    order,
    matActualValue: matActual,
    plannedVsActualQtys: { planned: matPlannedQty.toFixed(3), actual: matActualQty.toFixed(3) },
    componentsValue: compValue,
    output: out ?? null,
    yieldPct:
      out && dec(order.plannedQty).gt(0)
        ? dec(out.qty).div(dec(order.plannedQty)).times(100).toFixed(2)
        : null,
  };
}
