/**
 * Sales & profitability reports (REPORTING_SPECIFICATION §2 R-20…R-29) and the
 * income statement (R-04).
 *
 * Single source: POSTED sales documents. Revenue is net of discounts and of
 * returns (returns are their own documents, so they subtract naturally); free
 * goods are reported as quantity + cost, never as revenue. Profitability is
 * withheld when cost coverage is incomplete (INV-17 spirit) instead of showing a
 * fabricated margin.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { customers, salesInvoiceLines, salesInvoices, users } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { round2, balancesByType, type DateRange } from "./ledger";

export interface SalesByDimensionRow {
  label: string;
  key: string;
  net: number;
  vat: number;
  total: number;
  documents: number;
  /** quantity of free-goods lines (cost is reported separately) */
  freeQty: number;
  freeCost: number;
}

/** R-20/R-21/R-22/R-23 sales by a chosen dimension. */
export async function salesByDimension(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  dimension: "date" | "product" | "customer" | "branch" | "rep",
): Promise<{ rows: SalesByDimensionRow[]; totals: SalesByDimensionRow }> {
  void tenantId;
  const labelExpr: Record<string, string> = {
    date: "i.business_date",
    product: "p.sku || ' · ' || p.name_ar",
    customer: "coalesce(c.name_ar, 'عميل نقدي')",
    branch: "coalesce(b.name, '—')",
    rep: "coalesce(u.name, '—')",
  };
  const groupExpr: Record<string, string> = {
    date: "i.business_date",
    product: "p.sku, p.name_ar",
    customer: "c.name_ar",
    branch: "b.name",
    rep: "u.name",
  };
  // return lines carry a NEGATIVE sign: the report total is then net revenue, which is
  // exactly the ledger's revenue movement (sales gross is posted with contra accounts)
  const rows = await trx.execute(sql`
    select ${sql.raw(labelExpr[dimension])} as label,
           sum((case when l.line_kind = 'return_line' then -1 else 1 end) * l.net_amount)::text as net,
           sum((case when l.line_kind = 'return_line' then -1 else 1 end) * l.vat_amount)::text as vat,
           sum((case when l.line_kind = 'return_line' then -1 else 1 end) * (l.net_amount + l.vat_amount))::text as total,
           count(distinct i.id)::text as documents,
           coalesce(sum(case when l.line_kind = 'free' then l.qty_base else 0 end), 0)::text as free_qty,
           coalesce(sum(case when l.line_kind = 'free' then l.line_cogs else 0 end), 0)::text as free_cost
    from sales_invoice_lines l
    join sales_invoices i on i.id = l.invoice_id
    join products p on p.id = l.product_id
    left join customers c on c.id = i.customer_id
    left join warehouses w on w.id = i.warehouse_id
    left join branches b on b.id = w.branch_id
    left join users u on u.id = i.salesperson_user_id
    where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      ${range.from ? sql`and i.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and i.business_date <= ${range.to}` : sql``}
    group by ${sql.raw(groupExpr[dimension])}
    order by ${dimension === "date" ? sql`1 asc` : sql`2 desc`}
  `);
  const raw = (rows as unknown as {
    rows: {
      label: string;
      net: string;
      vat: string;
      total: string;
      documents: string;
      free_qty: string;
      free_cost: string;
    }[];
  }).rows;
  const mapped: SalesByDimensionRow[] = raw.map((r) => ({
    key: r.label,
    label: r.label,
    net: round2(Number(r.net)),
    vat: round2(Number(r.vat)),
    total: round2(Number(r.total)),
    documents: Number(r.documents),
    freeQty: round2(Number(r.free_qty)),
    freeCost: round2(Number(r.free_cost)),
  }));
  return {
    rows: mapped,
    totals: {
      key: "total",
      label: "total",
      net: round2(mapped.reduce((s, r) => s + r.net, 0)),
      vat: round2(mapped.reduce((s, r) => s + r.vat, 0)),
      total: round2(mapped.reduce((s, r) => s + r.total, 0)),
      documents: mapped.reduce((s, r) => s + r.documents, 0),
      freeQty: round2(mapped.reduce((s, r) => s + r.freeQty, 0)),
      freeCost: round2(mapped.reduce((s, r) => s + r.freeCost, 0)),
    },
  };
}

export interface CashVsCredit {
  cash: { net: number; total: number; documents: number };
  credit: { net: number; total: number; documents: number };
  receivablesOutstanding: number;
}

/** R-21 cash vs credit split on posted invoices + outstanding from allocations. */
export async function cashVsCredit(trx: Trx, tenantId: string, range: DateRange): Promise<CashVsCredit> {
  const rows = await trx.execute(sql`
    select case when i.is_credit then 'credit' else 'cash' end as kind,
           sum(i.subtotal)::text as net,
           sum(i.total)::text as total,
           count(*)::text as documents
    from sales_invoices i
    where i.tenant_id = ${tenantId} and i.business_status = 'posted' and i.invoice_type = 'sale'
      ${range.from ? sql`and i.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and i.business_date <= ${range.to}` : sql``}
    group by 1
  `);
  const raw = (rows as unknown as {
    rows: { kind: string; net: string; total: string; documents: string }[];
  }).rows;
  const pick = (kind: string) => {
    const row = raw.find((r) => r.kind === kind);
    return {
      net: round2(Number(row?.net ?? 0)),
      total: round2(Number(row?.total ?? 0)),
      documents: Number(row?.documents ?? 0),
    };
  };
  const outstanding = await trx.execute(sql`
    select coalesce(sum(i.total - coalesce((
      select sum(a.amount) from allocations a
      where a.tenant_id = i.tenant_id and a.invoice_id = i.id
    ), 0)), 0)::text as outstanding
    from sales_invoices i
    where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      ${range.to ? sql`and i.business_date <= ${range.to}` : sql``}
  `);
  return {
    cash: pick("cash"),
    credit: pick("credit"),
    receivablesOutstanding: round2(
      Number((outstanding as unknown as { rows: { outstanding: string }[] }).rows[0]?.outstanding ?? 0),
    ),
  };
}

/** R-22 returns & discounts as a share of gross sales. */
export async function returnsAndDiscounts(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{ gross: number; discounts: number; returnsNet: number; returnsPct: number; documents: number }> {
  const rows = await trx.execute(sql`
    select
      sum(case when i.invoice_type = 'sale_return' then 0 else i.subtotal + i.discount_total end)::text as gross,
      sum(i.discount_total)::text as discounts,
      sum(case when i.invoice_type = 'sale_return' then i.subtotal - i.discount_total else 0 end)::text as returns,
      count(case when i.invoice_type = 'sale_return' then 1 end)::text as documents
    from sales_invoices i
    where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      ${range.from ? sql`and i.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and i.business_date <= ${range.to}` : sql``}
  `);
  const row = (rows as unknown as {
    rows: { gross: string | null; discounts: string | null; returns: string | null; documents: string | null }[];
  }).rows[0];
  const gross = round2(Number(row?.gross ?? 0));
  const returnsNet = round2(Number(row?.returns ?? 0));
  return {
    gross,
    discounts: round2(Number(row?.discounts ?? 0)),
    returnsNet,
    returnsPct: gross === 0 ? 0 : round2((returnsNet / gross) * 100),
    documents: Number(row?.documents ?? 0),
  };
}

/** R-04 income statement from the ledger (P&L accounts only). */
export async function incomeStatement(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{
  revenue: number;
  expense: number;
  netIncome: number;
  byAccount: { accountId: string; code: string; nameAr: string; type: string; amount: number }[];
}> {
  const types = await balancesByType(trx, tenantId, range);
  const details = await trx.execute(sql`
    select a.id, a.code, a.name_ar, a.type,
           sum(l.credit - l.debit)::text as credit_minus_debit
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.tenant_id = ${tenantId} and e.status = 'posted' and a.type in ('revenue', 'expense')
      ${range.from ? sql`and e.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and e.business_date <= ${range.to}` : sql``}
    group by a.id, a.code, a.name_ar, a.type
    order by a.code
  `);
  const byAccount = (details as unknown as {
    rows: { id: string; code: string; name_ar: string; type: string; credit_minus_debit: string }[];
  }).rows.map((r) => ({
    accountId: r.id,
    code: r.code,
    nameAr: r.name_ar,
    type: r.type,
    amount: round2(r.type === "revenue" ? Number(r.credit_minus_debit) : -Number(r.credit_minus_debit)),
  }));
  return {
    revenue: types.revenue ?? 0,
    expense: types.expense ?? 0,
    netIncome: round2((types.revenue ?? 0) - (types.expense ?? 0)),
    byAccount,
  };
}

/**
 * R-12 profitability with an explicit coverage gate: when any sold line's COGS
 * value is missing the report reports coverage instead of a margin.
 */
export async function profitability(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  dimension: "product" | "customer" | "rep" = "product",
): Promise<{
  rows: { key: string; revenue: number; cogs: number; margin: number; marginPct: number }[];
  coverage: { linesWithCost: number; linesTotal: number; complete: boolean };
}> {
  const keyExpr: Record<string, string> = {
    product: "p.sku || ' · ' || p.name_ar",
    customer: "coalesce(c.name_ar, 'عميل نقدي')",
    rep: "coalesce(u.name, '—')",
  };
  const groupExpr: Record<string, string> = {
    product: "p.sku, p.name_ar",
    customer: "c.name_ar",
    rep: "u.name",
  };
  const rows = await trx.execute(sql`
    select ${sql.raw(keyExpr[dimension])} as key,
           sum((case when l.line_kind = 'return_line' then -1 else 1 end) * l.net_amount)::text as revenue,
           sum((case when l.line_kind = 'return_line' then -1 else 1 end) * coalesce(l.line_cogs, 0))::text as cogs,
           count(*)::text as lines_total,
           count(l.line_cogs)::text as lines_with_cost
    from sales_invoice_lines l
    join sales_invoices i on i.id = l.invoice_id
    join products p on p.id = l.product_id
    left join customers c on c.id = i.customer_id
    left join users u on u.id = i.salesperson_user_id
    where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      ${range.from ? sql`and i.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and i.business_date <= ${range.to}` : sql``}
    group by ${sql.raw(groupExpr[dimension])}
    order by 2 desc
  `);
  const raw = (rows as unknown as {
    rows: { key: string; revenue: string; cogs: string; lines_total: string; lines_with_cost: string }[];
  }).rows;
  const linesTotal = raw.reduce((s, r) => s + Number(r.lines_total), 0);
  const linesWithCost = raw.reduce((s, r) => s + Number(r.lines_with_cost), 0);
  const mapped = raw.map((r) => {
    const revenue = round2(Number(r.revenue));
    const cogs = round2(Number(r.cogs));
    return {
      key: r.key,
      revenue,
      cogs,
      margin: round2(revenue - cogs),
      marginPct: revenue === 0 ? 0 : round2(((revenue - cogs) / revenue) * 100),
    };
  });
  return {
    rows: mapped,
    coverage: { linesWithCost, linesTotal, complete: linesTotal === 0 || linesWithCost === linesTotal },
  };
}

/** R-25 collections by method/day (receipts are their own source table). */
export async function collections(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{ rows: { method: string; amount: number; pending: number }[]; total: number; pendingTotal: number }> {
  const rows = await trx.execute(sql`
    select rl.method,
           sum(rl.amount)::text as amount,
           coalesce(sum(case when rl.settlement_status = 'pending' then rl.amount else 0 end), 0)::text as pending
    from receipt_lines rl
    join receipts r on r.id = rl.receipt_id
    where r.tenant_id = ${tenantId} and r.status = 'posted'
      ${range.from ? sql`and r.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and r.business_date <= ${range.to}` : sql``}
    group by rl.method
    order by 2 desc
  `);
  const mapped = (rows as unknown as { rows: { method: string; amount: string; pending: string }[] }).rows.map((r) => ({
    method: r.method,
    amount: round2(Number(r.amount)),
    pending: round2(Number(r.pending)),
  }));
  return {
    rows: mapped,
    total: round2(mapped.reduce((s, r) => s + r.amount, 0)),
    pendingTotal: round2(mapped.reduce((s, r) => s + r.pending, 0)),
  };
}

/** Helper used by tests: posted sales documents in the range. */
export async function postedInvoiceCount(trx: Trx, tenantId: string, range: DateRange): Promise<number> {
  const conditions = [eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.businessStatus, "posted")];
  if (range.from) conditions.push(gte(salesInvoices.businessDate, range.from));
  if (range.to) conditions.push(lte(salesInvoices.businessDate, range.to));
  const [row] = await trx
    .select({ n: sql<string>`count(*)` })
    .from(salesInvoices)
    .where(and(...conditions));
  return Number(row?.n ?? 0);
}

export { customers, users, salesInvoiceLines };
