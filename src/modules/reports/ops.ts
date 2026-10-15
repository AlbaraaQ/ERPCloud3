/**
 * Operational reports: journal listing, cash/bank, expenses, period comparison, free
 * goods, settlements, exceptions, stock health, credit-note references, ZATCA audit
 * (REPORTING_SPECIFICATION R-05/R-06/R-09/R-11/R-13/R-23/R-28/R-29/R-43/R-44/R-64/R-66).
 *
 * Same discipline as the accounting services: one authoritative source per figure,
 * `business_date` filters, posted documents only, and an explicit note whenever the
 * data needed for a figure is not complete (never a silent zero).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { accounts, expenses, journalEntries, journalLines, postingMappings } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { round2, type DateRange } from "./ledger";

export interface JournalRow {
  entryId: string;
  entryNo: number | null;
  businessDate: string;
  sourceType: string;
  memo: string | null;
  debit: number;
  credit: number;
  lines: number;
  isReversal: boolean;
}

/** R-06 journal report — chronological posted entries in the range. */
export async function journalReport(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  opts: { sourceType?: string; limit?: number } = {},
): Promise<{ rows: JournalRow[]; totals: { debit: number; credit: number } }> {
  const rows = await trx.execute(sql`
    select e.id, e.entry_no, e.business_date, e.source_type, e.memo, e.reversal_of,
           coalesce(sum(l.debit), 0)::text as debit,
           coalesce(sum(l.credit), 0)::text as credit,
           count(l.id)::text as lines
    from journal_entries e
    left join journal_lines l on l.entry_id = e.id
    where e.tenant_id = ${tenantId} and e.status = 'posted'
      ${range.from ? sql`and e.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and e.business_date <= ${range.to}` : sql``}
      ${opts.sourceType ? sql`and e.source_type = ${opts.sourceType}` : sql``}
    group by e.id, e.entry_no, e.business_date, e.source_type, e.memo, e.reversal_of
    order by e.business_date, e.entry_no nulls last, e.id
    limit ${opts.limit ?? 500}
  `);
  const mapped = (rows as unknown as {
    rows: {
      id: string;
      entry_no: string | null;
      business_date: string;
      source_type: string;
      memo: string | null;
      reversal_of: string | null;
      debit: string;
      credit: string;
      lines: string;
    }[];
  }).rows.map((r) => ({
    entryId: r.id,
    entryNo: r.entry_no === null ? null : Number(r.entry_no),
    businessDate: r.business_date,
    sourceType: r.source_type,
    memo: r.memo,
    debit: round2(Number(r.debit)),
    credit: round2(Number(r.credit)),
    lines: Number(r.lines),
    isReversal: Boolean(r.reversal_of),
  }));
  return {
    rows: mapped,
    totals: {
      debit: round2(mapped.reduce((s, r) => s + r.debit, 0)),
      credit: round2(mapped.reduce((s, r) => s + r.credit, 0)),
    },
  };
}

export interface CashAccountRow {
  accountId: string;
  code: string;
  nameAr: string;
  mappingKey: string | null;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

/**
 * R-09 cash & bank balances. Source: the ledger (journal lines). The account set is
 * resolved through the posting-mapping contract (cash_default / bank_default /
 * card_clearing / rep_cash_custody) — never by hard-coded ids.
 */
export async function cashAndBank(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  asOf?: string,
): Promise<{ rows: CashAccountRow[]; totals: { opening: number; closing: number }; note?: string }> {
  const keys = ["cash_default", "bank_default", "card_clearing", "rep_cash_custody"];
  const mapped = await trx
    .select({ key: postingMappings.key, accountId: postingMappings.accountId, code: accounts.code, nameAr: accounts.nameAr })
    .from(postingMappings)
    .innerJoin(accounts, eq(accounts.id, postingMappings.accountId))
    .where(and(eq(postingMappings.tenantId, tenantId), inArray(postingMappings.key, keys)));

  const end = range.to ?? asOf;
  const rows: CashAccountRow[] = [];
  for (const m of mapped) {
    const r = await trx.execute(sql`
      select
        coalesce(sum(case when ${range.from ? sql`e.business_date < ${range.from}` : sql`false`} then l.debit - l.credit else 0 end), 0)::text as opening,
        coalesce(sum(case when ${range.from ? sql`e.business_date >= ${range.from}` : sql`true`}
                          and ${end ? sql`e.business_date <= ${end}` : sql`true`}
                     then l.debit else 0 end), 0)::text as debit,
        coalesce(sum(case when ${range.from ? sql`e.business_date >= ${range.from}` : sql`true`}
                          and ${end ? sql`e.business_date <= ${end}` : sql`true`}
                     then l.credit else 0 end), 0)::text as credit
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where e.tenant_id = ${tenantId} and e.status = 'posted' and l.account_id = ${m.accountId}
    `);
    const row = (r as unknown as { rows: { opening: string; debit: string; credit: string }[] }).rows[0];
    const opening = round2(Number(row.opening));
    const debit = round2(Number(row.debit));
    const credit = round2(Number(row.credit));
    rows.push({
      accountId: m.accountId,
      code: m.code,
      nameAr: m.nameAr,
      mappingKey: m.key,
      opening,
      debit,
      credit,
      closing: round2(opening + debit - credit),
    });
  }
  return {
    rows,
    totals: {
      opening: round2(rows.reduce((s, r) => s + r.opening, 0)),
      closing: round2(rows.reduce((s, r) => s + r.closing, 0)),
    },
    note:
      "card and wallet settlements appear on their clearing account, never as cash (R-09)",
  };
}

/** R-11 expense analysis by category with the document counts feeding each figure. */
export async function expenseAnalysis(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{
  rows: { category: string; amount: number; documents: number; posted: number }[];
  totals: { amount: number; pending: number };
}> {
  const rows = await trx.execute(sql`
    select category,
           sum(case when status = 'approved' then amount else 0 end)::text as amount,
           count(*)::text as documents,
           count(case when status = 'approved' then 1 end)::text as posted
    from expenses
    where tenant_id = ${tenantId}
      ${range.from ? sql`and business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and business_date <= ${range.to}` : sql``}
    group by category
    order by 2 desc
  `);
  const mapped = (rows as unknown as {
    rows: { category: string; amount: string; documents: string; posted: string }[];
  }).rows.map((r) => ({
    category: r.category,
    amount: round2(Number(r.amount)),
    documents: Number(r.documents),
    posted: Number(r.posted),
  }));
  const pending = await trx.execute(sql`
    select coalesce(sum(amount), 0)::text as pending from expenses
    where tenant_id = ${tenantId} and status = 'pending'
      ${range.from ? sql`and business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and business_date <= ${range.to}` : sql``}
  `);
  return {
    rows: mapped,
    totals: {
      amount: round2(mapped.reduce((s, r) => s + r.amount, 0)),
      pending: round2(Number((pending as unknown as { rows: { pending: string }[] }).rows[0]?.pending ?? 0)),
    },
  };
}

/**
 * R-13 period comparison — the same ledger figures for two adjacent ranges.
 * The prior range is derived from the current one (same length, immediately before).
 */
export async function periodComparison(
  trx: Trx,
  tenantId: string,
  range: Required<Pick<DateRange, "from" | "to">>,
): Promise<{ current: { from: string; to: string }; prior: { from: string; to: string }; rows: { label: string; current: number; prior: number; deltaPct: number }[] }> {
  const current = await withRange(trx, tenantId, range);
  const days = Math.max(
    1,
    Math.floor((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000),
  );
  const priorTo = addDays(range.from, -1);
  const priorFrom = addDays(priorTo, -days);
  const prior = await withRange(trx, tenantId, { from: priorFrom, to: priorTo });
  const labels: [string, "revenue" | "expense" | "net"][] = [
    ["rep.revenue", "revenue"],
    ["rep.expense", "expense"],
    ["rep.net", "net"],
  ];
  return {
    current: { from: range.from, to: range.to },
    prior: { from: priorFrom, to: priorTo },
    rows: labels.map(([label, key]) => {
      const a = current[key];
      const b = prior[key];
      return {
        label,
        current: a,
        prior: b,
        deltaPct: b === 0 ? (a === 0 ? 0 : 100) : round2(((a - b) / Math.abs(b)) * 100),
      };
    }),
  };
}

async function withRange(trx: Trx, tenantId: string, range: Required<Pick<DateRange, "from" | "to">>) {
  const { balancesByType } = await import("./ledger");
  const types = await balancesByType(trx, tenantId, range);
  return {
    revenue: types.revenue ?? 0,
    expense: types.expense ?? 0,
    net: round2((types.revenue ?? 0) - (types.expense ?? 0)),
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** R-23 free goods (qty + cost) — the exact source of the free-goods expense (D-021). */
export async function freeGoods(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{
  rows: { label: string; qty: number; cost: number; documents: number }[];
  totals: { qty: number; cost: number };
}> {
  const rows = await trx.execute(sql`
    select p.sku || ' · ' || p.name_ar as label,
           sum(l.qty_base)::text as qty,
           sum(coalesce(l.line_cogs, 0))::text as cost,
           count(distinct i.id)::text as documents
    from sales_invoice_lines l
    join sales_invoices i on i.id = l.invoice_id
    join products p on p.id = l.product_id
    where i.tenant_id = ${tenantId} and i.business_status = 'posted' and l.line_kind = 'free'
      ${range.from ? sql`and i.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and i.business_date <= ${range.to}` : sql``}
    group by p.sku, p.name_ar
    order by 3 desc
  `);
  const mapped = (rows as unknown as {
    rows: { label: string; qty: string; cost: string; documents: string }[];
  }).rows.map((r) => ({
    label: r.label,
    qty: round2(Number(r.qty)),
    cost: round2(Number(r.cost)),
    documents: Number(r.documents),
  }));
  return {
    rows: mapped,
    totals: {
      qty: round2(mapped.reduce((s, r) => s + r.qty, 0)),
      cost: round2(mapped.reduce((s, r) => s + r.cost, 0)),
    },
  };
}

/** R-28 rep settlement history (expected vs counted, with the difference kept visible). */
export async function settlementHistory(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<{
  rows: {
    settlementNo: number | null;
    repUserId: string;
    businessDate: string;
    status: string;
    expectedCash: number;
    countedCash: number;
    difference: number;
  }[];
  totals: { expected: number; counted: number; difference: number };
}> {
  const rows = await trx.execute(sql`
    select settlement_no, rep_user_id, business_date, status,
           coalesce(expected_cash, 0)::text as expected_cash,
           coalesce(counted_cash, 0)::text as counted_cash
    from settlements
    where tenant_id = ${tenantId}
      ${range.from ? sql`and business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and business_date <= ${range.to}` : sql``}
    order by business_date desc, settlement_no desc
    limit 300
  `);
  const mapped = (rows as unknown as {
    rows: {
      settlement_no: string | null;
      rep_user_id: string;
      business_date: string;
      status: string;
      expected_cash: string;
      counted_cash: string;
    }[];
  }).rows.map((r) => ({
    settlementNo: r.settlement_no === null ? null : Number(r.settlement_no),
    repUserId: r.rep_user_id,
    businessDate: r.business_date,
    status: r.status,
    expectedCash: round2(Number(r.expected_cash)),
    countedCash: round2(Number(r.counted_cash)),
    difference: round2(Number(r.counted_cash) - Number(r.expected_cash)),
  }));
  return {
    rows: mapped,
    totals: {
      expected: round2(mapped.reduce((s, r) => s + r.expectedCash, 0)),
      counted: round2(mapped.reduce((s, r) => s + r.countedCash, 0)),
      difference: round2(mapped.reduce((s, r) => s + r.difference, 0)),
    },
  };
}

/** R-29 open settlement exceptions (aging by the settlement's business date). */
export async function settlementExceptionsOpen(
  trx: Trx,
  tenantId: string,
  asOf: string,
): Promise<{
  rows: { kind: string; entity: string; expected: number; actual: number; diff: number; resolution: string; businessDate: string; ageDays: number }[];
  totals: { count: number; shortage: number; overage: number };
}> {
  const rows = await trx.execute(sql`
    select x.kind, x.entity, coalesce(x.expected, 0)::text as expected, coalesce(x.actual, 0)::text as actual,
           coalesce(x.diff, 0)::text as diff, x.resolution, s.business_date
    from settlement_exceptions x
    join settlements s on s.id = x.settlement_id
    where x.tenant_id = ${tenantId} and x.resolution = 'pending'
    order by s.business_date
    limit 300
  `);
  const mapped = (rows as unknown as {
    rows: {
      kind: string;
      entity: string;
      expected: string;
      actual: string;
      diff: string;
      resolution: string;
      business_date: string;
    }[];
  }).rows.map((r) => ({
    kind: r.kind,
    entity: r.entity,
    expected: round2(Number(r.expected)),
    actual: round2(Number(r.actual)),
    diff: round2(Number(r.diff)),
    resolution: r.resolution,
    businessDate: r.business_date,
    ageDays: Math.max(0, Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${r.business_date}T00:00:00Z`)) / 86_400_000)),
  }));
  return {
    rows: mapped,
    totals: {
      count: mapped.length,
      shortage: round2(mapped.filter((r) => r.kind === "shortage").reduce((s, r) => s + Math.abs(r.diff), 0)),
      overage: round2(mapped.filter((r) => r.kind === "overage").reduce((s, r) => s + Math.abs(r.diff), 0)),
    },
  };
}

/** R-43/R-44 stock health: last issue date, slow movers and items under their min qty. */
export async function stockHealth(
  trx: Trx,
  tenantId: string,
  asOf: string,
  opts: { slowDays?: number } = {},
): Promise<{
  slow: { sku: string; nameAr: string; warehouseName: string; qty: number; lastIssueDate: string | null; daysIdle: number | null }[];
  lowStock: { sku: string; nameAr: string; warehouseName: string; available: number; minQty: number }[];
  slowDays: number;
}> {
  const slowDays = opts.slowDays ?? 90;
  const slowRows = await trx.execute(sql`
    select p.sku, p.name_ar, w.name as warehouse_name,
           coalesce(b.on_hand, 0)::text as qty,
           (select max(sl.business_date) from stock_ledger sl
             where sl.tenant_id = ${tenantId} and sl.product_id = p.id and sl.warehouse_id = w.id
               and sl.qty_base < 0) as last_issue_date
    from stock_balances b
    join products p on p.id = b.product_id
    join warehouses w on w.id = b.warehouse_id
    where b.tenant_id = ${tenantId} and b.on_hand > 0
    order by p.sku
    limit 300
  `);
  const slow = (slowRows as unknown as {
    rows: { sku: string; name_ar: string; warehouse_name: string; qty: string; last_issue_date: string | null }[];
  }).rows
    .map((r) => {
      const daysIdle = r.last_issue_date
        ? Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${r.last_issue_date}T00:00:00Z`)) / 86_400_000)
        : null;
      return {
        sku: r.sku,
        nameAr: r.name_ar,
        warehouseName: r.warehouse_name,
        qty: round2(Number(r.qty)),
        lastIssueDate: r.last_issue_date,
        daysIdle,
      };
    })
    .filter((r) => r.daysIdle === null || r.daysIdle >= slowDays);

  const lowRows = await trx.execute(sql`
    select p.sku, p.name_ar, w.name as warehouse_name,
           (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))::text as available,
           coalesce(p.min_qty, 0)::text as min_qty
    from products p
    join warehouses w on w.tenant_id = p.tenant_id
    left join stock_balances b on b.product_id = p.id and b.warehouse_id = w.id
    where p.tenant_id = ${tenantId} and p.active = true and coalesce(p.min_qty, 0) > 0
      and (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0)) < coalesce(p.min_qty, 0)
    order by (coalesce(p.min_qty, 0) - (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))) desc
    limit 300
  `);
  return {
    slow,
    lowStock: (lowRows as unknown as {
      rows: { sku: string; name_ar: string; warehouse_name: string; available: string; min_qty: string }[];
    }).rows.map((r) => ({
      sku: r.sku,
      nameAr: r.name_ar,
      warehouseName: r.warehouse_name,
      available: round2(Number(r.available)),
      minQty: round2(Number(r.min_qty)),
    })),
    slowDays,
  };
}

/** R-64 credit/debit notes with the document they reference and its submission state. */
export async function noteReferences(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<
  { noteNo: number | null; businessDate: string; net: number; vat: number; originalInvoiceId: string | null; originalNo: number | null; submissionStatus: string | null }[]
> {
  const rows = await trx.execute(sql`
    select n.invoice_no as note_no, n.business_date, n.subtotal::text as net, n.vat_total::text as vat,
           n.original_invoice_id, o.invoice_no as original_no, s.status as submission_status
    from sales_invoices n
    left join sales_invoices o on o.id = n.original_invoice_id
    left join invoice_submissions s on s.invoice_id = n.id
    where n.tenant_id = ${tenantId} and n.business_status = 'posted' and n.invoice_type = 'sale_return'
      ${range.from ? sql`and n.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and n.business_date <= ${range.to}` : sql``}
    order by n.business_date desc
    limit 300
  `);
  return (rows as unknown as {
    rows: {
      note_no: string | null;
      business_date: string;
      net: string;
      vat: string;
      original_invoice_id: string | null;
      original_no: string | null;
      submission_status: string | null;
    }[];
  }).rows.map((r) => ({
    noteNo: r.note_no === null ? null : Number(r.note_no),
    businessDate: r.business_date,
    net: round2(Number(r.net)),
    vat: round2(Number(r.vat)),
    originalInvoiceId: r.original_invoice_id,
    originalNo: r.original_no === null ? null : Number(r.original_no),
    submissionStatus: r.submission_status,
  }));
}

/**
 * R-66 ZATCA integration audit: onboarding state, certificate events and the attempt log.
 * Everything shown here comes from stored rows — nothing is inferred from platform
 * behaviour that this build cannot observe (Phase 6 discipline, AC-025).
 */
export async function zatcaAudit(
  trx: Trx,
  tenantId: string,
): Promise<{
  certificates: { env: string; kind: string; label: string | null; status: string; expiresAt: string | null }[];
  checks: { runId: string; env: string; docKind: string; status: string; validationStatus: string | null }[];
  attempts: { docType: string; status: string; attempts: number; lastErrorClass: string | null }[];
  note: string;
}> {
  const certificates = await trx.execute(sql`
    select env, kind, label, status, expires_at from zatca_certificates
    where tenant_id = ${tenantId} order by created_at desc limit 50
  `);
  const checks = await trx.execute(sql`
    select run_id, env, doc_kind, status, validation_status from zatca_compliance_checks
    where tenant_id = ${tenantId} order by created_at desc limit 100
  `);
  const attempts = await trx.execute(sql`
    select doc_type, status, attempts, last_error_class from invoice_submissions
    where tenant_id = ${tenantId} order by created_at desc limit 200
  `);
  return {
    certificates: (certificates as unknown as {
      rows: { env: string; kind: string; label: string | null; status: string; expires_at: Date | string | null }[];
    }).rows.map((r) => ({
      env: r.env,
      kind: r.kind,
      label: r.label,
      status: r.status,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    })),
    checks: (checks as unknown as {
      rows: { run_id: string; env: string; doc_kind: string; status: string; validation_status: string | null }[];
    }).rows.map((r) => ({
      runId: r.run_id,
      env: r.env,
      docKind: r.doc_kind,
      status: r.status,
      validationStatus: r.validation_status,
    })),
    attempts: (attempts as unknown as {
      rows: { doc_type: string; status: string; attempts: string; last_error_class: string | null }[];
    }).rows.map((r) => ({
      docType: r.doc_type,
      status: r.status,
      attempts: Number(r.attempts),
      lastErrorClass: r.last_error_class,
    })),
    note: "records what this tenant stored; production FATOORA behaviour is not claimed here (AC-025)",
  };
}
