/**
 * Tax reports (REPORTING_SPECIFICATION §4 R-60…R-66) + the VAT reconciliation
 * assertion RL-5.
 *
 * Single source per figure (INV-13):
 *   - output VAT and taxable sales come from POSTED sales documents
 *     (`sales_invoices` + lines), never from the submissions journal;
 *   - input VAT comes from POSTED purchase invoices;
 *   - submission state comes from `invoice_submissions` (operational status, not a
 *     financial figure) — the two are reported side by side and reconciled in R-65.
 * Drafts never appear; reversals are separate documents (credit notes) and net
 * naturally because both sides of a return are posted documents.
 */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { invoiceSubmissions, purchaseInvoices, salesInvoiceLines, salesInvoices } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { round2, type DateRange } from "./ledger";

export interface RateRow {
  category: string;
  rate: string;
  net: number;
  vat: number;
  lines: number;
}

/** R-60 taxable sales by category/rate (posted documents only). */
export async function taxableSalesByRate(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{ rows: RateRow[]; totals: { net: number; vat: number } }> {
  void tenantId;
  const rows = await trx.execute(sql`
    select p.tax_category as category, l.vat_rate::text as rate,
           sum((case when l.line_kind = 'return_line' then -1 else 1 end) * l.net_amount)::text as net,
           sum((case when l.line_kind = 'return_line' then -1 else 1 end) * l.vat_amount)::text as vat,
           count(*)::text as lines
    from sales_invoice_lines l
    join sales_invoices i on i.id = l.invoice_id
    join products p on p.id = l.product_id
    where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      ${range.from ? sql`and i.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and i.business_date <= ${range.to}` : sql``}
    group by p.tax_category, l.vat_rate
    order by p.tax_category, l.vat_rate
  `);
  const raw = (rows as unknown as {
    rows: { category: string; rate: string; net: string; vat: string; lines: string }[];
  }).rows;
  const mapped: RateRow[] = raw.map((r) => ({
    category: r.category,
    rate: r.rate,
    net: round2(Number(r.net)),
    vat: round2(Number(r.vat)),
    lines: Number(r.lines),
  }));
  return {
    rows: mapped,
    totals: {
      net: round2(mapped.reduce((s, r) => s + r.net, 0)),
      vat: round2(mapped.reduce((s, r) => s + r.vat, 0)),
    },
  };
}

export interface VatReconciliation {
  from?: string;
  to?: string;
  outputNet: number;
  /** Σ line discounts on the same documents (they are already netted out of outputNet) */
  outputDiscount: number;
  /** credit notes in the range, shown separately and already netted out of the figures above */
  returnsNet: number;
  returnsVat: number;
  outputVat: number;
  inputNet: number;
  inputVat: number;
  netVat: number;
  documents: number;
  coverageNote?: string;
}

/** R-61/R-65 output vs input VAT over a business-date range. */
export async function vatReconciliation(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<VatReconciliation> {
  const conditions = [
    eq(salesInvoices.tenantId, tenantId),
    eq(salesInvoices.businessStatus, "posted"),
  ];
  if (range.from) conditions.push(gte(salesInvoices.businessDate, range.from));
  if (range.to) conditions.push(lte(salesInvoices.businessDate, range.to));
  const [sales] = await trx
    .select({
      // `subtotal` is already net of line discounts (see sales/invoices.ts), so the
      // document net is the column itself — discounts are NOT subtracted twice.
      net: sql<string>`coalesce(sum(case when ${salesInvoices.invoiceType} = 'sale_return' then 0 else ${salesInvoices.subtotal} end), 0)`,
      discount: sql<string>`coalesce(sum(${salesInvoices.discountTotal}), 0)`,
      vat: sql<string>`coalesce(sum(case when ${salesInvoices.invoiceType} = 'sale_return' then 0 else ${salesInvoices.vatTotal} end), 0)`,
      returnsNet: sql<string>`coalesce(sum(case when ${salesInvoices.invoiceType} = 'sale_return' then ${salesInvoices.subtotal} else 0 end), 0)`,
      returnsVat: sql<string>`coalesce(sum(case when ${salesInvoices.invoiceType} = 'sale_return' then ${salesInvoices.vatTotal} else 0 end), 0)`,
      docs: sql<string>`count(case when ${salesInvoices.invoiceType} <> 'sale_return' then 1 end)`,
    })
    .from(salesInvoices)
    .where(and(...conditions));

  const purchaseConditions = [eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.status, "posted")];
  if (range.from) purchaseConditions.push(gte(purchaseInvoices.businessDate, range.from));
  if (range.to) purchaseConditions.push(lte(purchaseInvoices.businessDate, range.to));
  const [purchases] = await trx
    .select({
      net: sql<string>`coalesce(sum(${purchaseInvoices.subtotal}), 0)`,
      vat: sql<string>`coalesce(sum(${purchaseInvoices.vatTotal}), 0)`,
    })
    .from(purchaseInvoices)
    .where(and(...purchaseConditions));

  // a credit note reduces both net sales and output VAT — the same sign rule the AR
  // subledger uses, so the VAT report nets to the VAT control account (RL-5)
  const outputNet = round2(Number(sales.net) - Number(sales.returnsNet));
  const outputVat = round2(Number(sales.vat) - Number(sales.returnsVat));
  const inputVat = round2(Number(purchases.vat));
  return {
    from: range.from,
    to: range.to,
    outputNet,
    outputDiscount: round2(Number(sales.discount)),
    outputVat,
    returnsNet: round2(Number(sales.returnsNet)),
    returnsVat: round2(Number(sales.returnsVat)),
    inputNet: round2(Number(purchases.net)),
    inputVat,
    netVat: round2(outputVat - inputVat),
    documents: Number(sales.docs),
    coverageNote:
      inputVat === 0 && outputVat !== 0
        ? "no input VAT recorded in the range — purchases may be unposted"
        : undefined,
  };
}

export interface SubmissionStatusReport {
  byStatus: { status: string; docType: string | null; count: number; oldestDays: number | null }[];
  pending: number;
  failed: number;
  rejected: number;
  total: number;
}

/** R-62/R-63 submission ledger by state with age (operational, not financial). */
export async function submissionStatus(
  trx: Trx,
  tenantId: string,
  range: DateRange = {},
): Promise<SubmissionStatusReport> {
  const conditions = [eq(invoiceSubmissions.tenantId, tenantId)];
  if (range.from) conditions.push(gte(invoiceSubmissions.submittedAt, new Date(`${range.from}T00:00:00Z`)));
  if (range.to) conditions.push(lte(invoiceSubmissions.submittedAt, new Date(`${range.to}T23:59:59Z`)));
  const rows = await trx
    .select({
      status: invoiceSubmissions.status,
      docType: invoiceSubmissions.docType,
      count: sql<string>`count(*)`,
      oldest: sql<string | null>`min(${invoiceSubmissions.submittedAt})`,
    })
    .from(invoiceSubmissions)
    .where(and(...conditions))
    .groupBy(invoiceSubmissions.status, invoiceSubmissions.docType);

  const now = Date.now();
  const byStatus = rows.map((r) => ({
    status: r.status,
    docType: r.docType,
    count: Number(r.count),
    oldestDays: r.oldest ? Math.floor((now - new Date(r.oldest).getTime()) / 86_400_000) : null,
  }));
  return {
    byStatus,
    pending: byStatus
      .filter((r) => ["issued_pending_reporting", "clearance_pending", "failed_retryable"].includes(r.status))
      .reduce((s, r) => s + r.count, 0),
    failed: byStatus.filter((r) => r.status === "failed_retryable").reduce((s, r) => s + r.count, 0),
    rejected: byStatus.filter((r) => r.status === "rejected").reduce((s, r) => s + r.count, 0),
    total: byStatus.reduce((s, r) => s + r.count, 0),
  };
}

/** R-63 action queue: rejected/blocked submissions with their diagnostics. */
export async function submissionActionQueue(
  trx: Trx,
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<
  {
    submissionId: string;
    invoiceUuid: string;
    docType: string;
    status: string;
    attempts: number;
    lastErrorClass: string | null;
    lastError: string | null;
    submittedAt: string | null;
  }[]
> {
  const rows = await trx
    .select({
      submissionId: invoiceSubmissions.id,
      invoiceUuid: invoiceSubmissions.invoiceUuid,
      docType: invoiceSubmissions.docType,
      status: invoiceSubmissions.status,
      attempts: invoiceSubmissions.attempts,
      lastErrorClass: invoiceSubmissions.lastErrorClass,
      lastError: invoiceSubmissions.lastError,
      submittedAt: invoiceSubmissions.submittedAt,
    })
    .from(invoiceSubmissions)
    .where(
      and(
        eq(invoiceSubmissions.tenantId, tenantId),
        inArray(invoiceSubmissions.status, ["rejected", "failed_retryable", "blocked_config"]),
      ),
    )
    .limit(opts.limit ?? 100);
  return rows.map((r) => ({
    submissionId: r.submissionId,
    invoiceUuid: r.invoiceUuid,
    docType: r.docType,
    status: r.status,
    attempts: Number(r.attempts),
    lastErrorClass: r.lastErrorClass,
    lastError: r.lastError,
    submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
  }));
}

/**
 * Posted tax documents in the range that have NO journal entry. A document-based VAT
 * report cannot agree with the GL VAT control accounts while such documents exist — the
 * reconciliation names them instead of leaving an unexplained difference.
 */
export async function unpostedTaxDocuments(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{ count: number; vat: number }> {
  const rows = await trx.execute(sql`
    select count(*)::text as n, coalesce(sum(d.vat_total), 0)::text as vat
    from (
      select i.id, i.vat_total, i.business_date from sales_invoices i
      where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      union all
      select p.id, p.vat_total, p.business_date from purchase_invoices p
      where p.tenant_id = ${tenantId} and p.status = 'posted'
    ) d
    where not exists (
      select 1 from journal_entries e
      where e.tenant_id = ${tenantId} and e.source_id = d.id and e.status = 'posted'
    )
    ${range.from ? sql`and d.business_date >= ${range.from}` : sql``}
    ${range.to ? sql`and d.business_date <= ${range.to}` : sql``}
  `);
  const row = (rows as unknown as { rows: { n: string; vat: string }[] }).rows[0];
  return { count: Number(row?.n ?? 0), vat: round2(Number(row?.vat ?? 0)) };
}

/**
 * Cross-check helper used by tests and the integrity banner: the VAT report figure
 * must equal the sum of invoice VAT for the same documents (proves the report is
 * not reading a second representation of the same fact).
 */
export async function invoiceVatFromLines(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<number> {
  const conditions = [eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.businessStatus, "posted")];
  if (range.from) conditions.push(gte(salesInvoices.businessDate, range.from));
  if (range.to) conditions.push(lte(salesInvoices.businessDate, range.to));
  const [row] = await trx
    .select({
      vat: sql<string>`coalesce(sum((case when ${salesInvoiceLines.lineKind} = 'return_line' then -1 else 1 end)
        * ${salesInvoiceLines.vatAmount}), 0)`,
    })
    .from(salesInvoiceLines)
    .innerJoin(salesInvoices, eq(salesInvoices.id, salesInvoiceLines.invoiceId))
    .where(and(...conditions));
  return round2(Number(row?.vat ?? 0));
}
