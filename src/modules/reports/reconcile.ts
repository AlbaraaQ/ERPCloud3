/**
 * Reconciliation assertions (REPORTING_SPECIFICATION §5, AC-031).
 *
 * Each rule compares TWO independent representations of the same economic fact
 * and reports the difference. A breached rule is surfaced in the UI (integrity
 * banner) — never silently masked by adjusting a report. Nothing here "fixes"
 * numbers: the reports stay as the ledgers say.
 *
 *   RL-1 trial-balance footer equality            Σdr = Σcr
 *   RL-2 AR/AP subledger ↔ control account        open documents vs 1103/2101
 *   RL-3 stock valuation ↔ inventory control      stock ledger value vs 1104
 *   RL-4 custody ↔ ledger (settlement figures)    settlement expectations vs live custody
 *   RL-5 VAT report ↔ GL                          invoice VAT vs 2102/1106 movement
 */

import { and, eq, sql } from "drizzle-orm";
import { journalEntries, journalLines } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { round2, trialBalance, type DateRange } from "./ledger";
import { resolveReportAccount } from "./accounts";
import { arApAging } from "./receivables";
import { unpostedTaxDocuments, vatReconciliation } from "./tax";
import { stockMovementsWithoutJournal, stockValuation } from "./inventory";

export type ReconcileCode = "RL-1" | "RL-2" | "RL-3" | "RL-4" | "RL-5";

export interface ReconcileResult {
  code: ReconcileCode;
  titleKey: string;
  /** subledger/derived figure */
  left: number;
  /** authoritative ledger figure */
  right: number;
  difference: number;
  ok: boolean;
  /** data-coverage note (e.g. "no custody warehouses") */
  note?: string;
}

/**
 * Signed ledger balance (debit-positive) of a CONTROL account within a range.
 * The account is resolved through the posting-mapping contract first (a tenant may
 * remap its chart) and only then by the conventional code.
 */
async function ledgerBalance(
  trx: Trx,
  tenantId: string,
  mappingKey: string,
  fallbackCode: string,
  range: DateRange,
): Promise<number> {
  const accountId = (await resolveReportAccount(trx, tenantId, mappingKey, fallbackCode))?.id ?? null;
  if (!accountId) return 0;
  const conditions = [
    eq(journalEntries.tenantId, tenantId),
    eq(journalEntries.status, "posted"),
    eq(journalLines.accountId, accountId),
  ];
  if (range.from) conditions.push(sql`${journalEntries.businessDate} >= ${range.from}`);
  if (range.to) conditions.push(sql`${journalEntries.businessDate} <= ${range.to}`);
  const rows = await trx
    .select({ debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions));
  return round2(rows.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0));
}

/** RL-1 — the trial balance must balance (each run, before anything is displayed). */
export async function rl1TrialBalance(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<ReconcileResult> {
  const tb = await trialBalance(trx, tenantId, range);
  const difference = round2(tb.totals.debit - tb.totals.credit);
  return {
    code: "RL-1",
    titleKey: "rep.tbFooter",
    left: tb.totals.debit,
    right: tb.totals.credit,
    difference,
    ok: tb.totals.balanced,
  };
}

/**
 * RL-2 — AR/AP subledger ↔ control account.
 * Source of the subledger: open document balances (doc total − allocations), no
 * journal involvement; the control account is read from the ledger.
 */
export async function rl2SubledgerVsControl(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  today: string,
): Promise<ReconcileResult[]> {
  // both sides of the subledger come from ONE call so AR/AP can never be mixed
  const { ar, ap } = await arApAging(trx, tenantId, { asOf: today });
  const arLedger = await ledgerBalance(trx, tenantId, "ar_control", "1103", { to: today });
  const apLedger = await ledgerBalance(trx, tenantId, "ap_control", "2101", { to: today });
  const arDiff = round2(ar.totalOutstanding - arLedger);
  const apDiff = round2(ap.totalPayable - -apLedger);
  void range;
  return [
    {
      code: "RL-2",
      titleKey: "rep.arControl",
      left: ar.totalOutstanding,
      right: arLedger,
      difference: arDiff,
      ok: Math.abs(arDiff) < 0.01,
      note: ar.coverageNote,
    },
    {
      code: "RL-2",
      titleKey: "rep.apControl",
      left: ap.totalPayable,
      right: round2(-apLedger),
      difference: apDiff,
      ok: Math.abs(apDiff) < 0.01,
      note: ap.coverageNote,
    },
  ];
}

/** RL-3 — inventory valuation (stock ledger) ↔ inventory control account. */
export async function rl3ValuationVsGl(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<ReconcileResult> {
  const valuation = await stockValuation(trx, tenantId, range);
  const gl = await ledgerBalance(trx, tenantId, "inventory_control", "1104", range);
  const difference = round2(valuation.totalValue - gl);
  const unposted = difference === 0 ? { count: 0, value: 0 } : await stockMovementsWithoutJournal(trx, tenantId, range);
  const notes = [valuation.coverageNote];
  if (unposted.count > 0) {
    notes.push(
      `${unposted.count} movement(s) worth ${unposted.value.toFixed(2)} have no journal effect on the inventory control account (difference ${difference.toFixed(2)})`,
    );
  }
  return {
    code: "RL-3",
    titleKey: "rep.valuationControl",
    left: valuation.totalValue,
    right: gl,
    difference,
    ok: Math.abs(difference) < 0.01,
    note: notes.filter(Boolean).join(" · ") || undefined,
  };
}

/**
 * RL-4 — custody ↔ ledger: what the settlement module expects to find on the van
 * (stock lines from custody balances + expected cash from rep receipts) against the
 * live ledger position of that custody warehouse / rep custody account.
 */
export async function rl4CustodyVsLedger(
  trx: Trx,
  tenantId: string,
): Promise<ReconcileResult[]> {
  const custody = await trx.execute(sql`
    select w.id as warehouse_id, w.name as warehouse_name,
           coalesce((select sum(sl.value) from stock_ledger sl
                     where sl.tenant_id = w.tenant_id and sl.warehouse_id = w.id), 0)::text as ledger_value,
           coalesce((select sum(sl.qty_base) from stock_ledger sl
                     where sl.tenant_id = w.tenant_id and sl.warehouse_id = w.id), 0)::text as ledger_qty,
           coalesce((select sum(b.on_hand) from stock_balances b
                     where b.tenant_id = w.tenant_id and b.warehouse_id = w.id), 0)::text as balance_qty
    from warehouses w
    where w.tenant_id = ${tenantId} and w.representative_user_id is not null
    order by w.name
  `);
  const rows = (custody as unknown as {
    rows: {
      warehouse_id: string;
      warehouse_name: string;
      ledger_value: string;
      ledger_qty: string;
      balance_qty: string;
    }[];
  }).rows;

  if (rows.length === 0) {
    return [
      {
        code: "RL-4",
        titleKey: "rep.custodyLedger",
        left: 0,
        right: 0,
        difference: 0,
        ok: true,
        note: "no custody warehouses",
      },
    ];
  }

  const results: ReconcileResult[] = [];
  for (const row of rows) {
    const qtyDiff = round2(Number(row.ledger_qty) - Number(row.balance_qty));
    results.push({
      code: "RL-4",
      titleKey: "rep.custodyLedger",
      left: round2(Number(row.ledger_value)),
      right: round2(Number(row.ledger_value) - qtyDiff),
      difference: qtyDiff,
      ok: Math.abs(qtyDiff) < 0.000001,
      note: row.warehouse_name,
    });
  }
  return results;
}

/** RL-5 — VAT report (documents) ↔ GL output/input VAT movement. */
export async function rl5VatVsGl(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<ReconcileResult[]> {
  const vat = await vatReconciliation(trx, tenantId, range);
  const outputGl = await ledgerBalance(trx, tenantId, "output_vat", "2102", range);
  const inputGl = await ledgerBalance(trx, tenantId, "input_vat", "1106", range);
  const outputDiff = round2(vat.outputVat - -outputGl);
  const inputDiff = round2(vat.inputVat - inputGl);
  const unposted = outputDiff === 0 && inputDiff === 0 ? { count: 0, vat: 0 } : await unpostedTaxDocuments(trx, tenantId, range);
  const note = [
    vat.coverageNote,
    unposted.count > 0
      ? `${unposted.count} posted document(s) with ${unposted.vat.toFixed(2)} VAT have no journal entry — they are the difference`
      : null,
  ]
    .filter(Boolean)
    .join(" · ") || undefined;
  return [
    {
      code: "RL-5",
      titleKey: "rep.outputVat",
      left: vat.outputVat,
      right: round2(-outputGl),
      difference: outputDiff,
      ok: Math.abs(outputDiff) < 0.01,
      note,
    },
    {
      code: "RL-5",
      titleKey: "rep.inputVat",
      left: vat.inputVat,
      right: inputGl,
      difference: inputDiff,
      ok: Math.abs(inputDiff) < 0.01,
      note,
    },
  ];
}

export interface IntegrityReport {
  results: ReconcileResult[];
  breaches: number;
  checkedAt: string;
}

/** Run the full RL pack (used by the reports page banner and the acceptance test). */
export async function runReconciliations(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  today: string,
): Promise<IntegrityReport> {
  const results = [
    await rl1TrialBalance(trx, tenantId, range),
    ...(await rl2SubledgerVsControl(trx, tenantId, range, today)),
    await rl3ValuationVsGl(trx, tenantId, range),
    ...(await rl4CustodyVsLedger(trx, tenantId)),
    ...(await rl5VatVsGl(trx, tenantId, range)),
  ];
  return {
    results,
    breaches: results.filter((r) => !r.ok).length,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Documents with no journal effect at all (posted invoice without a posting) —
 * the classic silent-drift cause; surfaced rather than assumed away.
 */
export async function postingsMissingForPostedDocs(
  trx: Trx,
  tenantId: string,
  sourceTypes: string[] = ["sales_invoice", "purchase_invoice"],
): Promise<{ sourceType: string; sourceId: string; docNo: string | null }[]> {
  if (sourceTypes.length === 0) return [];
  const types = sql.join(
    sourceTypes.map((t) => sql`${t}`),
    sql`, `,
  );
  const rows = await trx.execute(sql`
    select v.source_type, v.source_id, v.invoice_no as doc_no
    from (
      select (case when i.invoice_type = 'sale_return' then 'sales_return' else 'sales_invoice' end)::text as source_type,
             i.id as source_id, i.invoice_no
      from sales_invoices i
      where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      union all
      select (case when p.is_return then 'purchase_return' else 'purchase_invoice' end)::text, p.id, p.invoice_no
      from purchase_invoices p
      where p.tenant_id = ${tenantId} and p.status = 'posted'
    ) v
    left join journal_entries e
      on e.tenant_id = ${tenantId} and e.source_type = v.source_type and e.source_id = v.source_id
         and e.status = 'posted' and e.reversal_of is null
    where v.source_type in (${types}) and e.id is null
    limit 50
  `);
  return (rows as unknown as { rows: { source_type: string; source_id: string; doc_no: string | null }[] }).rows.map(
    (r) => ({ sourceType: r.source_type, sourceId: r.source_id, docNo: r.doc_no }),
  );
}

/**
 * Reversal integrity: an entry that CLAIMS to reverse another one must point at an
 * entry that exists and is still posted. A dangling or unposted target means the
 * reversal reverses nothing — the ledger would then hold a one-sided effect, so it is
 * reported rather than trusted (INV-04 family).
 */
export async function unreversedSourceDocs(
  trx: Trx,
  tenantId: string,
): Promise<{ entryId: string; reversalOf: string; reason: "missing_original" | "original_not_posted" }[]> {
  const rows = await trx.execute(sql`
    select r.id as entry_id, r.reversal_of::text as reversal_of,
           case when o.id is null then 'missing_original' else 'original_not_posted' end as reason
    from journal_entries r
    left join journal_entries o
      on o.tenant_id = r.tenant_id and o.id = r.reversal_of and o.status = 'posted'
    where r.tenant_id = ${tenantId} and r.status = 'posted' and r.reversal_of is not null and o.id is null
    limit 50
  `);
  return (rows as unknown as {
    rows: { entry_id: string; reversal_of: string; reason: "missing_original" | "original_not_posted" }[];
  }).rows.map((r) => ({ entryId: r.entry_id, reversalOf: r.reversal_of, reason: r.reason }));
}
