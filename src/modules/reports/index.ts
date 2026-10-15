/**
 * Report catalog + dispatcher (REPORTING_SPECIFICATION §1–§5).
 *
 * ONE contract for every report: a code, a title key, and a callable that returns
 * `columns` + `rows` + optional `totals` + `notes`. The page, the CSV export and the
 * drill-down links all consume this — so an export can never show a different figure
 * from the screen (they run the same service), and every report keeps its own
 * documented source (INV-13: never sum two representations of one fact).
 *
 * Reports whose data does not exist in this build are listed as `status: "pending"`
 * with the reason and are NOT rendered as numbers — an unimplemented report must say
 * so instead of printing a plausible zero.
 */

import { sql } from "drizzle-orm";
import type { Trx } from "@/modules/shared/db-context";
import { accountLedger, balancesByType, trialBalance, type AccountBalanceRow, type DateRange } from "./ledger";
import { apAging, arAging, outstandingDocuments } from "./receivables";
import { vatReconciliation, taxableSalesByRate, submissionStatus, submissionActionQueue } from "./tax";
import { expiryBands, movementLedger, stockOnHand, stockValuation } from "./inventory";
import {
  cashVsCredit,
  collections,
  incomeStatement,
  profitability,
  returnsAndDiscounts,
  salesByDimension,
} from "./sales";
import {
  cashAndBank,
  expenseAnalysis,
  freeGoods,
  journalReport,
  noteReferences,
  periodComparison,
  settlementExceptionsOpen,
  settlementHistory,
  stockHealth,
  zatcaAudit,
} from "./ops";
import { postingsMissingForPostedDocs, unreversedSourceDocs, type ReconcileResult } from "./reconcile";

export type ReportCell = string | number | null;

export interface ReportColumn {
  key: string;
  titleKey: string;
  kind: "text" | "money" | "qty" | "date" | "int";
}

export interface ReportRow {
  /** stable key used by drill-down links */
  id: string;
  cells: ReportCell[];
  /** where a permitted viewer can drill to */
  drill?: { report: string; params: Record<string, string> };
}

export interface ReportParams {
  from?: string;
  to?: string;
  asOf?: string;
  dim?: string;
  accountId?: string;
  warehouseId?: string;
  partyId?: string;
  slowDays?: string;
  includeZero?: string;
}

export interface ReportResult {
  code: string;
  titleKey: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportCell[];
  notes: string[];
  params: ReportParams;
  range: { from?: string; to?: string; asOf?: string };
}

export interface ReportDefinition {
  code: string;
  titleKey: string;
  group: "accounting" | "sales" | "inventory" | "tax" | "ops";
  needs: ("range" | "asOf")[];
  dims?: { key: string; titleKey: string }[];
  status: "ready" | "pending";
  /** why a pending report is not available yet (shown verbatim in the UI) */
  pendingReason?: string;
}

export const REPORT_CATALOG: ReportDefinition[] = [
  { code: "R-01", titleKey: "rep.r01", group: "accounting", needs: ["range"], status: "ready" },
  { code: "R-02", titleKey: "rep.r02", group: "accounting", needs: ["range"], status: "ready" },
  { code: "R-03", titleKey: "rep.r03", group: "accounting", needs: ["asOf"], status: "ready" },
  { code: "R-04", titleKey: "rep.r04", group: "accounting", needs: ["range"], status: "ready" },
  {
    code: "R-05",
    titleKey: "rep.r05",
    group: "accounting",
    needs: ["range"],
    status: "pending",
    pendingReason: "indirect-method classification of cash/bank counter-accounts is not configured in this build (spec §1 R-05 assumption)",
  },
  { code: "R-06", titleKey: "rep.r06", group: "accounting", needs: ["range"], status: "ready" },
  { code: "R-07", titleKey: "rep.r07", group: "accounting", needs: ["range"], status: "ready" },
  { code: "R-08", titleKey: "rep.r08", group: "accounting", needs: ["asOf"], status: "ready" },
  { code: "R-09", titleKey: "rep.r09", group: "accounting", needs: ["range", "asOf"], status: "ready" },
  {
    code: "R-10",
    titleKey: "rep.r10",
    group: "accounting",
    needs: ["asOf"],
    status: "pending",
    pendingReason: "bank statement import/ matching is not implemented (no statement source table in this build)",
  },
  { code: "R-11", titleKey: "rep.r11", group: "accounting", needs: ["range"], status: "ready" },
  {
    code: "R-12",
    titleKey: "rep.r12",
    group: "accounting",
    needs: ["range"],
    dims: [
      { key: "product", titleKey: "rep.dimProduct" },
      { key: "customer", titleKey: "rep.dimCustomer" },
      { key: "rep", titleKey: "rep.dimRep" },
    ],
    status: "ready",
  },
  { code: "R-13", titleKey: "rep.r13", group: "accounting", needs: ["range"], status: "ready" },

  { code: "R-20", titleKey: "rep.r20", group: "sales", needs: ["range"], dims: [
    { key: "date", titleKey: "rep.dimDate" },
    { key: "product", titleKey: "rep.dimProduct" },
    { key: "customer", titleKey: "rep.dimCustomer" },
    { key: "branch", titleKey: "rep.dimBranch" },
    { key: "rep", titleKey: "rep.dimRep" },
  ], status: "ready" },
  { code: "R-21", titleKey: "rep.r21", group: "sales", needs: ["range"], status: "ready" },
  { code: "R-22", titleKey: "rep.r22", group: "sales", needs: ["range"], status: "ready" },
  { code: "R-23", titleKey: "rep.r23", group: "sales", needs: ["range"], status: "ready" },
  {
    code: "R-24",
    titleKey: "rep.r24",
    group: "sales",
    needs: ["range"],
    status: "pending",
    pendingReason: "rejected override attempts are not persisted (only accepted overrides are stored on the line)",
  },
  { code: "R-25", titleKey: "rep.r25", group: "sales", needs: ["range"], status: "ready" },
  { code: "R-26", titleKey: "rep.r26", group: "sales", needs: ["asOf"], status: "ready" },
  {
    code: "R-27",
    titleKey: "rep.r27",
    group: "sales",
    needs: ["range"],
    status: "pending",
    pendingReason: "commission rules (Phase 4) are not configured for any tenant in this build",
  },
  { code: "R-28", titleKey: "rep.r28", group: "sales", needs: ["range"], status: "ready" },
  { code: "R-29", titleKey: "rep.r29", group: "sales", needs: ["asOf"], status: "ready" },

  { code: "R-40", titleKey: "rep.r40", group: "inventory", needs: [], status: "ready" },
  { code: "R-41", titleKey: "rep.r41", group: "inventory", needs: ["range"], status: "ready" },
  { code: "R-42", titleKey: "rep.r42", group: "inventory", needs: [], status: "ready" },
  { code: "R-43", titleKey: "rep.r43", group: "inventory", needs: ["asOf"], status: "ready" },
  { code: "R-44", titleKey: "rep.r44", group: "inventory", needs: ["asOf"], status: "ready" },
  { code: "R-45", titleKey: "rep.r45", group: "inventory", needs: ["asOf"], status: "ready" },
  {
    code: "R-46",
    titleKey: "rep.r46",
    group: "inventory",
    needs: [],
    status: "pending",
    pendingReason: "quarantine/scrap outcome tracking is not implemented (scrap is a stock movement, not a workflow)",
  },
  {
    code: "R-47",
    titleKey: "rep.r47",
    group: "inventory",
    needs: ["range"],
    status: "pending",
    pendingReason: "production output/yield reporting belongs to the manufacturing closure work (Phase 8)",
  },
  {
    code: "R-48",
    titleKey: "rep.r48",
    group: "inventory",
    needs: ["range"],
    status: "pending",
    pendingReason: "raw-material planned-vs-actual variance needs the Phase 8 cost closure",
  },
  {
    code: "R-49",
    titleKey: "rep.r49",
    group: "inventory",
    needs: ["range"],
    status: "pending",
    pendingReason: "scrap reasons are not classified per movement in this build",
  },
  {
    code: "R-50",
    titleKey: "rep.r50",
    group: "inventory",
    needs: ["range"],
    status: "pending",
    pendingReason: "manufacturing cost absorption is Phase 8 (P-22 closure evidence)",
  },
  {
    code: "R-51",
    titleKey: "rep.r51",
    group: "inventory",
    needs: [],
    status: "pending",
    pendingReason: "lot genealogy raw→output is not recorded in this build (Phase 8)",
  },

  { code: "R-60", titleKey: "rep.r60", group: "tax", needs: ["range"], status: "ready" },
  { code: "R-61", titleKey: "rep.r61", group: "tax", needs: ["range"], status: "ready" },
  { code: "R-62", titleKey: "rep.r62", group: "tax", needs: ["range"], status: "ready" },
  { code: "R-63", titleKey: "rep.r63", group: "tax", needs: [], status: "ready" },
  { code: "R-64", titleKey: "rep.r64", group: "tax", needs: ["range"], status: "ready" },
  { code: "R-65", titleKey: "rep.r65", group: "tax", needs: ["range"], status: "ready" },
  { code: "R-66", titleKey: "rep.r66", group: "tax", needs: [], status: "ready" },
];

const text = (key: string, titleKey: string): ReportColumn => ({ key, titleKey, kind: "text" });
const money = (key: string, titleKey: string): ReportColumn => ({ key, titleKey, kind: "money" });
const qty = (key: string, titleKey: string): ReportColumn => ({ key, titleKey, kind: "qty" });

function sum(rows: ReportRow[], index: number): number {
  return rows.reduce((s, r) => s + (typeof r.cells[index] === "number" ? (r.cells[index] as number) : 0), 0);
}

function stamp(result: Omit<ReportResult, "code" | "titleKey" | "params" | "range">, def: ReportDefinition, params: ReportParams): ReportResult {
  return {
    code: def.code,
    titleKey: def.titleKey,
    params,
    range: { from: params.from, to: params.to, asOf: params.asOf },
    ...result,
  };
}

function accountRows(list: AccountBalanceRow[], codeOf: (r: AccountBalanceRow) => string): ReportRow[] {
  return list.map((r) => ({
    id: codeOf(r),
    cells: [r.code, r.nameAr, r.debit, r.credit, r.net],
    drill: { report: "R-01", params: { accountId: r.accountId } },
  }));
}

/**
 * Run one report. `def.status === "pending"` throws a configuration error carrying the
 * documented reason — the UI renders the reason, never a number.
 */
export async function runReport(
  trx: Trx,
  tenantId: string,
  code: string,
  params: ReportParams,
): Promise<ReportResult> {
  const def = REPORT_CATALOG.find((d) => d.code === code);
  if (!def) throw new Error(`unknown report ${code}`);
  if (def.status === "pending") throw new Error(`report ${code} is not implemented: ${def.pendingReason}`);
  const range: DateRange = { from: params.from, to: params.to };
  const asOf = params.asOf ?? params.to ?? new Date().toISOString().slice(0, 10);

  switch (code) {
    case "R-01":
    case "R-07": {
      if (!params.accountId) {
        return stamp({ columns: [], rows: [], notes: ["choose an account to view its ledger"], totals: [] }, def, params);
      }
      const st = await accountLedger(trx, tenantId, params.accountId, range);
      const account = await trx.execute(
        sql`
          select code, name_ar from accounts where tenant_id = ${tenantId} and id = ${params.accountId} limit 1
        `,
      );
      const head = (account as unknown as { rows: { code: string; name_ar: string }[] }).rows[0];
      const rows: ReportRow[] = st.lines.map((l, i) => ({
        id: `${l.entryId}-${l.lineNo}-${i}`,
        cells: [l.businessDate, l.entryNo, l.sourceType, l.memo, l.debit, l.credit, l.runningBalance],
      }));
      return stamp(
        {
          columns: [
            text("date", "rep.colDate"),
            text("entryNo", "rep.colEntryNo"),
            text("source", "rep.colSource"),
            text("memo", "rep.colMemo"),
            money("debit", "rep.colDebit"),
            money("credit", "rep.colCredit"),
            money("balance", "rep.colBalance"),
          ],
          rows,
          totals: ["", "", "", "opening", "", "", st.opening],
          notes: [
            `${head?.code ?? ""} · ${head?.name_ar ?? ""}`,
            `closing balance ${st.closing}`,
            "opening is the balance of everything posted before the range start",
          ],
        },
        def,
        params,
      );
    }
    case "R-02": {
      const tb = await trialBalance(trx, tenantId, range, { includeZero: params.includeZero === "1" });
      const rows = accountRows(tb.rows, (r) => r.code);
      return stamp(
        {
          columns: [
            text("code", "rep.colCode"),
            text("name", "rep.colName"),
            money("debit", "rep.colDebit"),
            money("credit", "rep.colCredit"),
            money("balance", "rep.colBalance"),
          ],
          rows,
          totals: ["", "total", tb.totals.debit, tb.totals.credit, tb.totals.credit - tb.totals.debit],
          notes: [
            tb.totals.balanced ? "RL-1: Σdr = Σcr" : "RL-1 BREACH: Σdr ≠ Σcr",
          ],
        },
        def,
        params,
      );
    }
    case "R-03": {
      const types = await balancesByType(trx, tenantId, { to: asOf });
      const bs = await trx.execute(
        sql`
        select a.type, a.code, a.name_ar,
               sum(l.debit - l.credit)::text as dr_minus_cr
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
        where e.tenant_id = ${tenantId} and e.status = 'posted' and e.business_date <= ${asOf}
          and a.type in ('asset', 'liability', 'equity')
        group by a.type, a.code, a.name_ar
        order by a.code
      `);
      const rows: ReportRow[] = (bs as unknown as {
        rows: { type: string; code: string; name_ar: string; dr_minus_cr: string }[];
      }).rows.map((r) => {
        const signed = r.type === "asset" ? Number(r.dr_minus_cr) : -Number(r.dr_minus_cr);
        return {
          id: r.code,
          cells: [r.code, r.name_ar, r.type, Math.round(signed * 100) / 100],
          drill: { report: "R-01", params: {} },
        };
      });
      const assets = rows.filter((r) => r.cells[2] === "asset").reduce((s, r) => s + Number(r.cells[3]), 0);
      const liabilities = rows.filter((r) => r.cells[2] === "liability").reduce((s, r) => s + Number(r.cells[3]), 0);
      const equity = rows.filter((r) => r.cells[2] === "equity").reduce((s, r) => s + Number(r.cells[3]), 0);
      const netIncome = (types.revenue ?? 0) - (types.expense ?? 0);
      return stamp(
        {
          columns: [text("code", "rep.colCode"), text("name", "rep.colName"), text("type", "rep.colType"), money("balance", "rep.colBalance")],
          rows,
          totals: ["", "total", "A vs L+E", Math.round((assets - (liabilities + equity + netIncome)) * 100) / 100],
          notes: [
            `assets ${assets.toFixed(2)} = liabilities ${liabilities.toFixed(2)} + equity ${equity.toFixed(2)} + result ${netIncome.toFixed(2)}`,
            `difference ${(assets - (liabilities + equity + netIncome)).toFixed(2)}`,
          ],
        },
        def,
        params,
      );
    }
    case "R-04": {
      const income = await incomeStatement(trx, tenantId, range);
      const rows: ReportRow[] = income.byAccount.map((a) => ({
        id: a.code,
        cells: [a.code, a.nameAr, a.type, a.amount],
        drill: { report: "R-01", params: {} },
      }));
      return stamp(
        {
          columns: [text("code", "rep.colCode"), text("name", "rep.colName"), text("type", "rep.colType"), money("amount", "rep.colAmount")],
          rows,
          totals: ["", "net income", "", income.netIncome],
          notes: [`revenue ${income.revenue.toFixed(2)} · expense ${income.expense.toFixed(2)}`],
        },
        def,
        params,
      );
    }
    case "R-06": {
      const journal = await journalReport(trx, tenantId, range);
      const rows: ReportRow[] = journal.rows.map((r) => ({
        id: r.entryId,
        cells: [r.businessDate, r.entryNo, r.sourceType, r.memo, r.debit, r.credit, r.isReversal ? "↩︎" : ""],
      }));
      return stamp(
        {
          columns: [
            text("date", "rep.colDate"),
            text("entryNo", "rep.colEntryNo"),
            text("source", "rep.colSource"),
            text("memo", "rep.colMemo"),
            money("debit", "rep.colDebit"),
            money("credit", "rep.colCredit"),
            text("reversal", "rep.colReversal"),
          ],
          rows,
          totals: ["", "", "", "total", journal.totals.debit, journal.totals.credit, ""],
          notes: ["reversal entries are listed as first-class rows"],
        },
        def,
        params,
      );
    }
    case "R-08": {
      const aging = await arAging(trx, tenantId, { asOf });
      const rows: ReportRow[] = aging.rows.map((r) => ({
        id: r.partyId,
        cells: [r.partyCode, r.partyName, r.documents, r.current, r.d1_30, r.d31_60, r.d61_90, r.d90_plus, r.total],
        drill: { report: "R-26", params: { partyId: r.partyId } },
      }));
      return stamp(
        {
          columns: [
            text("code", "rep.colCode"),
            text("name", "rep.colName"),
            text("docs", "rep.colDocuments"),
            money("current", "rep.bucketCurrent"),
            money("d1_30", "rep.bucket1_30"),
            money("d31_60", "rep.bucket31_60"),
            money("d61_90", "rep.bucket61_90"),
            money("d90_plus", "rep.bucket90plus"),
            money("total", "rep.colTotal"),
          ],
          rows,
          totals: ["", "total", "", aging.buckets.current, aging.buckets.d1_30, aging.buckets.d31_60, aging.buckets.d61_90, aging.buckets.d90_plus, aging.buckets.total],
          notes: aging.coverageNote ? [aging.coverageNote] : [],
        },
        def,
        params,
      );
    }
    case "R-09": {
      const cash = await cashAndBank(trx, tenantId, range, asOf);
      const rows: ReportRow[] = cash.rows.map((r) => ({
        id: r.accountId,
        cells: [r.code, r.nameAr, r.mappingKey, r.opening, r.debit, r.credit, r.closing],
        drill: { report: "R-01", params: { accountId: r.accountId } },
      }));
      return stamp(
        {
          columns: [
            text("code", "rep.colCode"),
            text("name", "rep.colName"),
            text("mapping", "rep.colMapping"),
            money("opening", "rep.colOpening"),
            money("debit", "rep.colDebit"),
            money("credit", "rep.colCredit"),
            money("closing", "rep.colClosing"),
          ],
          rows,
          totals: ["", "total", "", cash.totals.opening, "", "", cash.totals.closing],
          notes: cash.note ? [cash.note] : [],
        },
        def,
        params,
      );
    }
    case "R-11": {
      const exp = await expenseAnalysis(trx, tenantId, range);
      const rows: ReportRow[] = exp.rows.map((r) => ({
        id: r.category,
        cells: [r.category, r.amount, r.posted, r.documents - r.posted],
      }));
      return stamp(
        {
          columns: [
            text("category", "rep.colCategory"),
            money("amount", "rep.colAmount"),
            text("posted", "rep.colPosted"),
            text("pending", "rep.colPending"),
          ],
          rows,
          totals: ["total", exp.totals.amount, "", exp.totals.pending],
          notes: ["only approved (posted) expenses feed the total; pending documents are shown separately"],
        },
        def,
        params,
      );
    }
    case "R-12": {
      const dim = (params.dim ?? "product") as "product" | "customer" | "rep";
      const p = await profitability(trx, tenantId, range, dim);
      const rows: ReportRow[] = p.rows.map((r) => ({
        id: r.key,
        cells: [r.key, r.revenue, r.cogs, r.margin, r.marginPct],
      }));
      const notes = p.coverage.complete
        ? [`cost coverage complete (${p.coverage.linesWithCost}/${p.coverage.linesTotal} lines)`]
        : [
            `COST COVERAGE INCOMPLETE: ${p.coverage.linesWithCost}/${p.coverage.linesTotal} lines carry a captured cost — margins for the rest must not be used`,
          ];
      return stamp(
        {
          columns: [
            text("key", "rep.colKey"),
            money("revenue", "rep.colRevenue"),
            money("cogs", "rep.colCogs"),
            money("margin", "rep.colMargin"),
            text("marginPct", "rep.colMarginPct"),
          ],
          rows,
          totals: ["total", sum(rows, 1), sum(rows, 2), sum(rows, 3), ""],
          notes,
        },
        def,
        params,
      );
    }
    case "R-13": {
      if (!params.from || !params.to) throw new Error("R-13 needs a date range");
      const cmp = await periodComparison(trx, tenantId, { from: params.from, to: params.to });
      const rows: ReportRow[] = cmp.rows.map((r) => ({ id: r.label, cells: [r.label, r.current, r.prior, r.deltaPct] }));
      return stamp(
        {
          columns: [text("label", "rep.colKey"), money("current", "rep.colCurrent"), money("prior", "rep.colPrior"), text("deltaPct", "rep.colDeltaPct")],
          rows,
          totals: [],
          notes: [`current ${cmp.current.from}…${cmp.current.to}`, `prior ${cmp.prior.from}…${cmp.prior.to}`],
        },
        def,
        params,
      );
    }
    case "R-20": {
      const dim = (params.dim ?? "date") as "date" | "product" | "customer" | "branch" | "rep";
      const s = await salesByDimension(trx, tenantId, range, dim);
      const rows: ReportRow[] = s.rows.map((r) => ({
        id: r.key,
        cells: [r.label, r.documents, r.net, r.vat, r.total, r.freeQty, r.freeCost],
      }));
      return stamp(
        {
          columns: [
            text("label", "rep.colKey"),
            text("documents", "rep.colDocuments"),
            money("net", "rep.colNet"),
            money("vat", "rep.colVat"),
            money("total", "rep.colTotal"),
            qty("freeQty", "rep.colFreeQty"),
            money("freeCost", "rep.colFreeCost"),
          ],
          rows,
          totals: ["total", s.totals.documents, s.totals.net, s.totals.vat, s.totals.total, s.totals.freeQty, s.totals.freeCost],
          notes: ["credit notes are signed negative so the total is net revenue (ties to R-04)"],
        },
        def,
        params,
      );
    }
    case "R-21": {
      const c = await cashVsCredit(trx, tenantId, range);
      const rows: ReportRow[] = [c.cash, c.credit].map((r, i) => ({
        id: i === 0 ? "cash" : "credit",
        cells: [i === 0 ? "cash" : "credit", r.documents, r.net, r.total],
      }));
      return stamp(
        {
          columns: [text("kind", "rep.colType"), text("documents", "rep.colDocuments"), money("net", "rep.colNet"), money("total", "rep.colTotal")],
          rows,
          totals: ["total", c.cash.documents + c.credit.documents, Math.round((c.cash.net + c.credit.net) * 100) / 100, Math.round((c.cash.total + c.credit.total) * 100) / 100],
          notes: [`outstanding receivables ${c.receivablesOutstanding.toFixed(2)} (R-08 detail)`],
        },
        def,
        params,
      );
    }
    case "R-22": {
      const r = await returnsAndDiscounts(trx, tenantId, range);
      const rows: ReportRow[] = [
        { id: "gross", cells: ["gross sales (list)", r.gross] },
        { id: "discounts", cells: ["line discounts", r.discounts] },
        { id: "returns", cells: ["credit notes", r.returnsNet] },
      ];
      return stamp(
        {
          columns: [text("label", "rep.colKey"), money("amount", "rep.colAmount")],
          rows,
          totals: ["returns as % of gross", r.returnsPct],
          notes: [`${r.documents} credit note(s) in the range`],
        },
        def,
        params,
      );
    }
    case "R-23": {
      const f = await freeGoods(trx, tenantId, range);
      const rows: ReportRow[] = f.rows.map((r) => ({ id: r.label, cells: [r.label, r.qty, r.cost, r.documents] }));
      return stamp(
        {
          columns: [text("label", "rep.colKey"), qty("qty", "rep.colQty"), money("cost", "rep.colCost"), text("documents", "rep.colDocuments")],
          rows,
          totals: ["total", f.totals.qty, f.totals.cost, ""],
          notes: ["cost of free goods is expensed (D-021) — it never appears as revenue"],
        },
        def,
        params,
      );
    }
    case "R-25": {
      const c = await collections(trx, tenantId, range);
      const rows: ReportRow[] = c.rows.map((r) => ({ id: r.method, cells: [r.method, r.amount, r.pending] }));
      return stamp(
        {
          columns: [text("method", "rep.colMethod"), money("amount", "rep.colAmount"), money("pending", "rep.colUnsettled")],
          rows,
          totals: ["total", c.total, c.pendingTotal],
          notes: ["unsettled e-payments are shown distinctly and never counted as cash"],
        },
        def,
        params,
      );
    }
    case "R-26": {
      const docs = await outstandingDocuments(trx, tenantId, { asOf });
      const filtered = params.partyId ? docs : docs;
      const rows: ReportRow[] = filtered.map((d) => ({ id: d.invoiceId, cells: [d.invoiceNo, d.party, d.businessDate, d.dueDate, d.outstanding] }));
      return stamp(
        {
          columns: [text("invoiceNo", "rep.colInvoiceNo"), text("party", "rep.colName"), text("date", "rep.colDate"), text("due", "rep.colDueDate"), money("outstanding", "rep.colOutstanding")],
          rows,
          totals: ["", "total", "", "", rows.reduce((s, r) => s + Number(r.cells[4]), 0)],
          notes: ["source: posted documents minus allocations (same formula the receipt guard uses)"],
        },
        def,
        params,
      );
    }
    case "R-28": {
      const h = await settlementHistory(trx, tenantId, range);
      const rows: ReportRow[] = h.rows.map((r) => ({
        id: `${r.settlementNo ?? "draft"}-${r.businessDate}`,
        cells: [r.settlementNo, r.businessDate, r.status, r.expectedCash, r.countedCash, r.difference],
      }));
      return stamp(
        {
          columns: [text("no", "rep.colEntryNo"), text("date", "rep.colDate"), text("status", "rep.colStatus"), money("expected", "rep.colExpected"), money("counted", "rep.colCounted"), money("difference", "rep.colDifference")],
          rows,
          totals: ["", "", "", h.totals.expected, h.totals.counted, h.totals.difference],
          notes: ["differences are left visible; resolving them is a settlement decision, not a report edit"],
        },
        def,
        params,
      );
    }
    case "R-29": {
      const e = await settlementExceptionsOpen(trx, tenantId, asOf);
      const rows: ReportRow[] = e.rows.map((r) => ({
        id: `${r.kind}-${r.entity}-${r.businessDate}`,
        cells: [r.businessDate, r.ageDays, r.kind, r.entity, r.expected, r.actual, r.diff],
      }));
      return stamp(
        {
          columns: [text("date", "rep.colDate"), text("age", "rep.colAge"), text("kind", "rep.colType"), text("entity", "rep.colSource"), money("expected", "rep.colExpected"), money("actual", "rep.colActual"), money("difference", "rep.colDifference")],
          rows,
          totals: ["", "", "", "open", "", "", e.totals.shortage - e.totals.overage],
          notes: [`${e.totals.count} open exception(s); shortages ${e.totals.shortage.toFixed(2)} · overages ${e.totals.overage.toFixed(2)}`],
        },
        def,
        params,
      );
    }
    case "R-40": {
      const s = await stockOnHand(trx, tenantId, { warehouseId: params.warehouseId });
      const rows: ReportRow[] = s.rows.map((r) => ({
        id: `${r.warehouseId}-${r.productId}`,
        cells: [r.warehouseName, r.sku, r.productName, r.qtyLedger, r.qtyBalance, r.reserved, r.available, r.value],
      }));
      return stamp(
        {
          columns: [text("warehouse", "rep.colWarehouse"), text("sku", "rep.colSku"), text("name", "rep.colName"), qty("qty", "rep.colQty"), qty("balanceQty", "rep.colBalanceQty"), qty("reserved", "rep.colReserved"), qty("available", "rep.colAvailable"), money("value", "rep.colValue")],
          rows,
          totals: ["", "", "total", s.totals.qty, "", "", "", s.totals.value],
          notes: s.coverageNote ? [s.coverageNote] : [],
        },
        def,
        params,
      );
    }
    case "R-41": {
      const m = await movementLedger(trx, tenantId, { warehouseId: params.warehouseId, from: params.from, to: params.to });
      const rows: ReportRow[] = m.map((r, i) => ({
        id: `${r.businessDate}-${i}`,
        cells: [r.businessDate, r.movementType, r.qty, r.value, r.runningQty, `${r.sourceType}/${r.sourceId.slice(0, 8)}`],
      }));
      return stamp(
        {
          columns: [text("date", "rep.colDate"), text("type", "rep.colType"), qty("qty", "rep.colQty"), money("value", "rep.colValue"), qty("running", "rep.colBalance"), text("source", "rep.colSource")],
          rows,
          totals: ["", "", rows.reduce((s, r) => s + Number(r.cells[2]), 0), rows.reduce((s, r) => s + Number(r.cells[3]), 0), "", ""],
          notes: ["signed quantity and value per movement (source of stock_balances)"],
        },
        def,
        params,
      );
    }
    case "R-42": {
      const v = await stockValuation(trx, tenantId, {});
      const rows: ReportRow[] = v.rows.map((r) => ({
        id: `${r.productId}-${r.warehouseName}`,
        cells: [r.sku, r.productName, r.warehouseName, r.qty, r.unitCost, r.value],
      }));
      return stamp(
        {
          columns: [text("sku", "rep.colSku"), text("name", "rep.colName"), text("warehouse", "rep.colWarehouse"), qty("qty", "rep.colQty"), money("unitCost", "rep.colUnitCost"), money("value", "rep.colValue")],
          rows,
          totals: ["", "", "total", v.totalQty, "", v.totalValue],
          notes: [v.coverageNote ?? "RL-3: valuation ties to the inventory control account", `uncosted rows: ${v.uncostedProducts}`],
        },
        def,
        params,
      );
    }
    case "R-43":
    case "R-44": {
      const health = await stockHealth(trx, tenantId, asOf, { slowDays: params.slowDays ? Number(params.slowDays) : undefined });
      if (code === "R-43") {
        const rows: ReportRow[] = health.slow.map((r) => ({ id: `${r.sku}-${r.warehouseName}`, cells: [r.sku, r.nameAr, r.warehouseName, r.qty, r.lastIssueDate, r.daysIdle] }));
        return stamp(
          {
            columns: [text("sku", "rep.colSku"), text("name", "rep.colName"), text("warehouse", "rep.colWarehouse"), qty("qty", "rep.colQty"), text("lastIssue", "rep.colLastIssue"), text("daysIdle", "rep.colDaysIdle")],
            rows,
            totals: [],
            notes: [`threshold ${health.slowDays} day(s) without an issue movement`],
          },
          def,
          params,
        );
      }
      const rows: ReportRow[] = health.lowStock.map((r) => ({ id: `${r.sku}-${r.warehouseName}`, cells: [r.sku, r.nameAr, r.warehouseName, r.available, r.minQty] }));
      return stamp(
        {
          columns: [text("sku", "rep.colSku"), text("name", "rep.colName"), text("warehouse", "rep.colWarehouse"), qty("available", "rep.colAvailable"), qty("min", "rep.colMinQty")],
          rows,
          totals: [],
          notes: ["threshold is the product's min_qty per warehouse (product master, not a report parameter)"],
        },
        def,
        params,
      );
    }
    case "R-45": {
      const bands = await expiryBands(trx, tenantId, asOf);
      const rows: ReportRow[] = [
        { id: "expired", cells: ["expired", bands.expired] },
        { id: "d30", cells: ["≤ 30 days", bands.d30] },
        { id: "d60", cells: ["31–60 days", bands.d60] },
        { id: "d90", cells: ["61–90 days", bands.d90] },
        { id: "later", cells: ["later / no expiry", bands.later] },
      ];
      return stamp(
        {
          columns: [text("band", "rep.colKey"), qty("qty", "rep.colQty")],
          rows,
          totals: ["total", rows.reduce((s, r) => s + Number(r.cells[1]), 0)],
          notes: [`as of ${asOf} (tenant business date)`],
        },
        def,
        params,
      );
    }
    case "R-60": {
      const t = await taxableSalesByRate(trx, tenantId, range);
      const rows: ReportRow[] = t.rows.map((r) => ({ id: `${r.category}-${r.rate}`, cells: [r.category, r.rate, r.net, r.vat, r.lines] }));
      return stamp(
        {
          columns: [text("category", "rep.colTaxCategory"), text("rate", "rep.colRate"), money("net", "rep.colNet"), money("vat", "rep.colVat"), text("lines", "rep.colLines")],
          rows,
          totals: ["total", "", t.totals.net, t.totals.vat, ""],
          notes: ["source: posted invoice lines (credit-note lines signed negative)"],
        },
        def,
        params,
      );
    }
    case "R-61":
    case "R-65": {
      const v = await vatReconciliation(trx, tenantId, range);
      const rows: ReportRow[] = [
        { id: "out-net", cells: ["output VAT — taxable base", v.outputNet] },
        { id: "out-discount", cells: ["line discounts (already netted)", v.outputDiscount] },
        { id: "out-return", cells: ["output VAT — credit notes base", -v.returnsNet] },
        { id: "out", cells: ["output VAT", v.outputVat] },
        { id: "in-net", cells: ["input VAT — purchases base", v.inputNet] },
        { id: "in", cells: ["input VAT", v.inputVat] },
      ];
      return stamp(
        {
          columns: [text("label", "rep.colKey"), money("amount", "rep.colAmount")],
          rows,
          totals: ["net VAT (indication, filing is external)", v.netVat],
          notes: [v.coverageNote ?? "documents only; RL-5 compares this to the GL VAT accounts"],
        },
        def,
        params,
      );
    }
    case "R-62": {
      const s = await submissionStatus(trx, tenantId, range);
      const rows: ReportRow[] = s.byStatus.map((r) => ({ id: `${r.status}-${r.docType ?? "?"}`, cells: [r.status, r.docType ?? "—", r.count, r.oldestDays] }));
      return stamp(
        {
          columns: [text("status", "rep.colStatus"), text("docType", "rep.colDocType"), text("count", "rep.colCount"), text("age", "rep.colAge")],
          rows,
          totals: ["total", "", s.total, ""],
          notes: [`pending ${s.pending} · rejected ${s.rejected}`, "state comes from invoice_submissions — never inferred from the platform"],
        },
        def,
        params,
      );
    }
    case "R-63": {
      const q = await submissionActionQueue(trx, tenantId);
      const rows: ReportRow[] = q.map((r) => ({ id: r.submissionId, cells: [r.docType, r.status, r.attempts, r.lastErrorClass, r.lastError] }));
      return stamp(
        {
          columns: [text("docType", "rep.colDocType"), text("status", "rep.colStatus"), text("attempts", "rep.colAttempts"), text("errorClass", "rep.colErrorClass"), text("error", "rep.colError")],
          rows,
          totals: [],
          notes: ["this is the action queue: every row is a document whose submission did not complete"],
        },
        def,
        params,
      );
    }
    case "R-64": {
      const notes = await noteReferences(trx, tenantId, range);
      const rows: ReportRow[] = notes.map((n) => ({
        id: `${n.noteNo}`,
        cells: [n.noteNo, n.businessDate, n.net, n.vat, n.originalNo, n.submissionStatus],
      }));
      return stamp(
        {
          columns: [text("note", "rep.colNoteNo"), text("date", "rep.colDate"), money("net", "rep.colNet"), money("vat", "rep.colVat"), text("original", "rep.colOriginalNo"), text("status", "rep.colStatus")],
          rows,
          totals: ["", "", rows.reduce((s, r) => s + Number(r.cells[2]), 0), rows.reduce((s, r) => s + Number(r.cells[3]), 0), "", ""],
          notes: ["credit notes always reference their original invoice (BillingReference)"],
        },
        def,
        params,
      );
    }
    case "R-66": {
      const audit = await zatcaAudit(trx, tenantId);
      const rows: ReportRow[] = [
        ...audit.certificates.map((c, i) => ({ id: `cert-${i}`, cells: ["certificate", c.env, c.kind, c.status, c.expiresAt] })),
        ...audit.checks.map((c, i) => ({ id: `check-${i}-${c.docKind}`, cells: ["compliance check", c.env, c.docKind, c.status, c.validationStatus] })),
        ...audit.attempts.map((a, i) => ({ id: `attempt-${i}-${a.docType}`, cells: ["submission", a.status, a.docType, String(a.attempts), a.lastErrorClass] })),
      ];
      return stamp(
        {
          columns: [text("kind", "rep.colType"), text("env", "rep.colEnv"), text("detail", "rep.colSource"), text("status", "rep.colStatus"), text("extra", "rep.colDetail")],
          rows,
          totals: [],
          notes: [audit.note],
        },
        def,
        params,
      );
    }
    default:
      throw new Error(`no implementation for ${code}`);
  }
}

/** Integrity pack for the banner (RL-1…RL-5). */
export async function integrityPack(trx: Trx, tenantId: string, range: DateRange, today: string): Promise<ReconcileResult[]> {
  const { runReconciliations } = await import("./reconcile");
  const report = await runReconciliations(trx, tenantId, range, today);
  return report.results;
}

/** Documents with no journal effect + dangling reversals (audit-style listings). */
export async function integrityAudit(trx: Trx, tenantId: string) {
  const missing = await postingsMissingForPostedDocs(trx, tenantId);
  const dangling = await unreversedSourceDocs(trx, tenantId);
  return { missing, dangling };
}

/** Report list grouped for the sidebar (ready first, then documented pending ones). */
export function catalogByGroup(): Record<string, ReportDefinition[]> {
  const out: Record<string, ReportDefinition[]> = {};
  for (const def of REPORT_CATALOG) {
    out[def.group] = out[def.group] ?? [];
    out[def.group].push(def);
  }
  return out;
}

export { accountLedger, apAging, arAging, balancesByType, trialBalance, vatReconciliation };
