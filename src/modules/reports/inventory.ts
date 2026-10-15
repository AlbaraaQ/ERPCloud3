/**
 * Inventory reports (REPORTING_SPECIFICATION §3 R-40/R-41/R-42/R-45).
 *
 * Single source: the stock LEDGER (`stock_ledger`, signed qty/value per movement)
 * — never the cached balance table for figures that feed a reconciliation. The
 * balance table is shown next to it so drift is visible (RL-4 reports it).
 * Valuation is quantity × policy cost: the ledger's own signed value, so a
 * revaluation or a scrap is reflected exactly once.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { products, stockLots, warehouses } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { round2, type DateRange } from "./ledger";
import { resolveReportAccount } from "./accounts";

export interface StockOnHandRow {
  warehouseId: string;
  warehouseName: string;
  productId: string;
  sku: string;
  productName: string;
  qtyLedger: number;
  qtyBalance: number;
  reserved: number;
  available: number;
  /** signed ledger value (policy cost) */
  value: number;
  /** qty × avg cost from the balance table (display only) */
  avgCost: number;
  /** ledger qty − balance qty: non-zero = drift, surfaced not hidden */
  drift: number;
}

/** R-40 stock on hand (ledger qty, balance qty, reserved, available). */
export async function stockOnHand(
  trx: Trx,
  tenantId: string,
  range: DateRange & { warehouseId?: string } = {},
): Promise<{ rows: StockOnHandRow[]; totals: { qty: number; value: number }; coverageNote?: string }> {
  const rows = await trx.execute(sql`
    select w.id as warehouse_id, w.name as warehouse_name,
           p.id as product_id, p.sku, p.name_ar as product_name,
           coalesce(l.qty, 0)::text as qty_ledger,
           coalesce(b.on_hand, 0)::text as qty_balance,
           coalesce(b.reserved, 0)::text as reserved,
           coalesce(b.avg_cost, 0)::text as avg_cost,
           coalesce(l.value, 0)::text as value
    from products p
    join warehouses w on w.tenant_id = p.tenant_id
    left join (
      select warehouse_id, product_id, sum(qty_base) as qty, sum(value) as value
      from stock_ledger
      where tenant_id = ${tenantId}
        ${range.from ? sql`and business_date >= ${range.from}` : sql``}
        ${range.to ? sql`and business_date <= ${range.to}` : sql``}
      group by warehouse_id, product_id
    ) l on l.warehouse_id = w.id and l.product_id = p.id
    left join stock_balances b on b.warehouse_id = w.id and b.product_id = p.id
    where p.tenant_id = ${tenantId} and p.active = true
      ${range.warehouseId ? sql`and w.id = ${range.warehouseId}` : sql``}
      and (coalesce(l.qty, 0) <> 0 or coalesce(b.on_hand, 0) <> 0 or coalesce(b.reserved, 0) <> 0)
    order by w.name, p.sku
  `);
  const raw = (rows as unknown as {
    rows: {
      warehouse_id: string;
      warehouse_name: string;
      product_id: string;
      sku: string;
      product_name: string;
      qty_ledger: string;
      qty_balance: string;
      reserved: string;
      avg_cost: string;
      value: string;
    }[];
  }).rows;

  let qty = 0;
  let value = 0;
  const mapped: StockOnHandRow[] = raw.map((r) => {
    const qtyLedger = Number(r.qty_ledger);
    const qtyBalance = Number(r.qty_balance);
    const reserved = Number(r.reserved);
    const rowValue = Number(r.value);
    qty = round2(qty + qtyLedger);
    value = round2(value + rowValue);
    return {
      warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      qtyLedger: round2(qtyLedger),
      qtyBalance: round2(qtyBalance),
      reserved: round2(reserved),
      available: round2(qtyBalance - reserved),
      value: round2(rowValue),
      avgCost: round2(Number(r.avg_cost)),
      drift: round2(qtyLedger - qtyBalance),
    };
  });
  const drifting = mapped.filter((m) => Math.abs(m.drift) > 0.000001).length;
  return {
    rows: mapped,
    totals: { qty, value },
    coverageNote: drifting > 0 ? `${drifting} row(s) differ between ledger and balance table` : undefined,
  };
}

export interface ValuationRow {
  productId: string;
  sku: string;
  productName: string;
  warehouseName: string;
  qty: number;
  value: number;
  unitCost: number;
}

export interface ValuationReport {
  rows: ValuationRow[];
  totalValue: number;
  totalQty: number;
  /** products that carry quantity but no ledger value → margin/valuation caveat */
  uncostedProducts: number;
  coverageNote?: string;
}

/**
 * R-42 inventory valuation ↔ GL inventory control (RL-3).
 * The ledger value is authoritative; `uncosted` rows are reported instead of being
 * silently valued at zero.
 */
export async function stockValuation(
  trx: Trx,
  tenantId: string,
  range: DateRange = {},
): Promise<ValuationReport> {
  const rows = await trx.execute(sql`
    select p.id as product_id, p.sku, p.name_ar as product_name, w.name as warehouse_name,
           sum(sl.qty_base)::text as qty, sum(sl.value)::text as value
    from stock_ledger sl
    join products p on p.id = sl.product_id
    join warehouses w on w.id = sl.warehouse_id
    where sl.tenant_id = ${tenantId}
      ${range.from ? sql`and sl.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and sl.business_date <= ${range.to}` : sql``}
    group by p.id, p.sku, p.name_ar, w.name
    having sum(sl.qty_base) <> 0 or sum(sl.value) <> 0
    order by p.sku, w.name
  `);
  const raw = (rows as unknown as {
    rows: { product_id: string; sku: string; product_name: string; warehouse_name: string; qty: string; value: string }[];
  }).rows;

  let totalValue = 0;
  let totalQty = 0;
  let uncostedProducts = 0;
  const mapped: ValuationRow[] = raw.map((r) => {
    const qty = Number(r.qty);
    const value = round2(Number(r.value));
    if (Math.abs(value) < 0.005 && Math.abs(qty) > 0.000001) uncostedProducts += 1;
    totalValue = round2(totalValue + value);
    totalQty = round2(totalQty + qty);
    return {
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      warehouseName: r.warehouse_name,
      qty: round2(qty),
      value,
      unitCost: qty === 0 ? 0 : round2(value / qty),
    };
  });
  return {
    rows: mapped,
    totalValue,
    totalQty,
    uncostedProducts,
    coverageNote:
      uncostedProducts > 0
        ? `${uncostedProducts} row(s) hold quantity without a ledger value — profitability must not be claimed for them`
        : undefined,
  };
}

/** R-41 movement ledger for one product/warehouse (drill-down support). */
export async function movementLedger(
  trx: Trx,
  tenantId: string,
  filter: { productId?: string; warehouseId?: string; from?: string; to?: string; limit?: number },
): Promise<
  {
    businessDate: string;
    movementType: string;
    qty: number;
    value: number;
    runningQty: number;
    sourceType: string;
    sourceId: string;
    memo: string | null;
  }[]
> {
  const rows = await trx.execute(sql`
    select business_date, movement_type, qty_base::text as qty, value::text as value,
           source_type, source_id, memo,
           sum(qty_base) over (order by business_date, occurred_at, id)::text as running_qty
    from stock_ledger
    where tenant_id = ${tenantId}
      ${filter.productId ? sql`and product_id = ${filter.productId}` : sql``}
      ${filter.warehouseId ? sql`and warehouse_id = ${filter.warehouseId}` : sql``}
      ${filter.from ? sql`and business_date >= ${filter.from}` : sql``}
      ${filter.to ? sql`and business_date <= ${filter.to}` : sql``}
    order by business_date, occurred_at, id
    limit ${filter.limit ?? 500}
  `);
  return (rows as unknown as {
    rows: {
      business_date: string;
      movement_type: string;
      qty: string;
      value: string;
      source_type: string;
      source_id: string;
      memo: string | null;
      running_qty: string;
    }[];
  }).rows.map((r) => ({
    businessDate: r.business_date,
    movementType: r.movement_type,
    qty: round2(Number(r.qty)),
    value: round2(Number(r.value)),
    runningQty: round2(Number(r.running_qty)),
    sourceType: r.source_type,
    sourceId: r.source_id,
    memo: r.memo,
  }));
}

/** R-45 batch & expiry bands (30/60/90/expired) for lot-tracked products. */
export async function expiryBands(
  trx: Trx,
  tenantId: string,
  today: string,
): Promise<{ expired: number; d30: number; d60: number; d90: number; later: number }> {
  const rows = await trx
    .select({
      expiryDate: stockLots.expiryDate,
      qtyOnHand: stockLots.qtyOnHand,
      productId: stockLots.productId,
      name: products.nameAr,
    })
    .from(stockLots)
    .innerJoin(products, eq(products.id, stockLots.productId))
    .where(and(eq(stockLots.tenantId, tenantId), sql`${stockLots.qtyOnHand} <> 0`))
    .orderBy(asc(stockLots.expiryDate));

  const out = { expired: 0, d30: 0, d60: 0, d90: 0, later: 0 };
  for (const row of rows) {
    const qty = Math.abs(Number(row.qtyOnHand));
    if (!row.expiryDate) {
      out.later += qty;
      continue;
    }
    const days = Math.floor((Date.parse(`${row.expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (days < 0) out.expired += qty;
    else if (days <= 30) out.d30 += qty;
    else if (days <= 60) out.d60 += qty;
    else if (days <= 90) out.d90 += qty;
    else out.later += qty;
  }
  return out;
}

/**
 * Stock movements with NO journal effect on the inventory control account.
 *
 * This is the honest explanation for a valuation↔control difference: every movement
 * carries a value, but only the posting paths (purchase, sale, return, production,
 * settlement, opening) also write a line on the control account. A movement created
 * directly by a tool or an import — or a posting path that clears through another
 * account — drifts the two representations apart. Naming them beats showing an
 * unexplained delta.
 */
export async function stockMovementsWithoutJournal(
  trx: Trx,
  tenantId: string,
  range: DateRange = {},
): Promise<{ count: number; value: number }> {
  const control = await resolveReportAccount(trx, tenantId, "inventory_control", "1104");
  if (!control) return { count: 0, value: 0 };
  const rows = await trx.execute(sql`
    select count(*)::text as n, coalesce(sum(sl.value), 0)::text as value
    from stock_ledger sl
    where sl.tenant_id = ${tenantId}
      ${range.from ? sql`and sl.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and sl.business_date <= ${range.to}` : sql``}
      and not exists (
        select 1 from journal_entries e
        join journal_lines l on l.entry_id = e.id
        where e.tenant_id = sl.tenant_id and e.source_id = sl.source_id
          and e.status = 'posted' and l.account_id = ${control.id}
      )
  `);
  const row = (rows as unknown as { rows: { n: string; value: string }[] }).rows[0];
  return { count: Number(row?.n ?? 0), value: round2(Number(row?.value ?? 0)) };
}

/** Warehouse lookup used by filters (kept here so reports share one list). */
export async function warehouseList(trx: Trx, tenantId: string) {
  return trx
    .select({ id: warehouses.id, name: warehouses.name, code: warehouses.code })
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, tenantId)))
    .orderBy(asc(warehouses.name));
}
