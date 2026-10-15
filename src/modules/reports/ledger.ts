/**
 * Reporting core (Phase 7) — REPORTING_SPECIFICATION.
 *
 * Universal rules implemented here once, so every report inherits them:
 *   - one authoritative source per figure (INV-13): ledger reports read
 *     `journal_entries`/`journal_lines` ONLY, subledger reports read document
 *     tables + allocations, valuation reads the stock ledger;
 *   - `business_date` range filters (tenant local business date, D-016);
 *   - DRAFT entries are excluded — a posted entry is the only thing that moves a
 *     balance (INV-03/INV-10), and reversals are ordinary posted entries, so they
 *     net naturally instead of being special-cased (no double counting);
 *   - tenant predicates are explicit on every query (RLS is the second layer, not
 *     the only one);
 *   - amounts round to 2 decimals for display, comparisons keep stored precision.
 *
 * Reconciliation assertions (RL-1…RL-5) live in `reconcile.ts` and are surfaced by
 * the UI instead of being silently satisfied.
 */

import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";

export interface DateRange {
  /** inclusive `business_date >= from` */
  from?: string;
  /** inclusive `business_date <= to` */
  to?: string;
}

export interface AccountNode {
  id: string;
  code: string;
  nameAr: string;
  type: string;
  parentId: string | null;
  isGroup: boolean;
  isControl: boolean;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** All accounts of a tenant, ordered by code (report traversal input). */
export async function accountList(trx: Trx, tenantId: string): Promise<AccountNode[]> {
  return trx
    .select({
      id: accounts.id,
      code: accounts.code,
      nameAr: accounts.nameAr,
      type: accounts.type,
      parentId: accounts.parentId,
      isGroup: accounts.isGroup,
      isControl: accounts.isControl,
    })
    .from(accounts)
    .where(eq(accounts.tenantId, tenantId))
    .orderBy(asc(accounts.code));
}

/** children index + subtree map (a group account aggregates its descendants). */
export function buildTree(list: AccountNode[]) {
  const byParent = new Map<string | null, AccountNode[]>();
  for (const a of list) {
    const arr = byParent.get(a.parentId ?? null) ?? [];
    arr.push(a);
    byParent.set(a.parentId ?? null, arr);
  }
  const descendants = new Map<string, string[]>();
  const walk = (id: string): string[] => {
    const cached = descendants.get(id);
    if (cached) return cached;
    const out = [id];
    for (const child of byParent.get(id) ?? []) out.push(...walk(child.id));
    descendants.set(id, out);
    return out;
  };
  for (const a of list) walk(a.id);
  return { byParent, descendants };
}

export interface AccountBalanceRow {
  accountId: string;
  code: string;
  nameAr: string;
  type: string;
  isGroup: boolean;
  isControl: boolean;
  openingDebit: number;
  openingCredit: number;
  debit: number;
  credit: number;
  /** Σdr − Σcr over the range */
  net: number;
  /** opening + net (signed; debit-positive) */
  closing: number;
}

interface RawBalance {
  debit: number;
  credit: number;
}

async function movementBalances(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  accountIds?: string[],
): Promise<Map<string, RawBalance>> {
  const conditions = [eq(journalEntries.tenantId, tenantId), eq(journalEntries.status, "posted")];
  if (range.from) conditions.push(gte(journalEntries.businessDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.businessDate, range.to));
  if (accountIds?.length) conditions.push(inArray(journalLines.accountId, accountIds));
  const rows = await trx
    .select({ accountId: journalLines.accountId, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions));
  const out = new Map<string, RawBalance>();
  for (const row of rows) {
    const cur = out.get(row.accountId) ?? { debit: 0, credit: 0 };
    cur.debit += Number(row.debit);
    cur.credit += Number(row.credit);
    out.set(row.accountId, cur);
  }
  return out;
}

/** Opening balances (strictly before `from`) per account. */
async function openingBalances(
  trx: Trx,
  tenantId: string,
  from: string | undefined,
  accountIds?: string[],
): Promise<Map<string, RawBalance>> {
  const out = new Map<string, RawBalance>();
  if (!from) return out;
  const conditions = [
    eq(journalEntries.tenantId, tenantId),
    eq(journalEntries.status, "posted"),
    sql`${journalEntries.businessDate} < ${from}`,
  ];
  if (accountIds?.length) conditions.push(inArray(journalLines.accountId, accountIds));
  const rows = await trx
    .select({ accountId: journalLines.accountId, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions));
  for (const row of rows) {
    const cur = out.get(row.accountId) ?? { debit: 0, credit: 0 };
    cur.debit += Number(row.debit);
    cur.credit += Number(row.credit);
    out.set(row.accountId, cur);
  }
  return out;
}

/**
 * R-02 Trial Balance: per account Σdr/Σcr/net for the range plus opening and
 * closing columns. `includeZero` keeps accounts with no movement (audit view).
 */
export async function trialBalance(
  trx: Trx,
  tenantId: string,
  range: DateRange,
  opts: { includeZero?: boolean } = {},
): Promise<{ rows: AccountBalanceRow[]; totals: { debit: number; credit: number; balanced: boolean } }> {
  const list = await accountList(trx, tenantId);
  const movement = await movementBalances(trx, tenantId, range);
  const opening = await openingBalances(trx, tenantId, range.from);
  const byId = new Map(list.map((a) => [a.id, a]));

  const rows: AccountBalanceRow[] = [];
  const build = (account: AccountNode, mv: RawBalance): AccountBalanceRow => {
    const op = opening.get(account.id) ?? { debit: 0, credit: 0 };
    return {
      accountId: account.id,
      code: account.code,
      nameAr: account.nameAr,
      type: account.type,
      isGroup: account.isGroup,
      isControl: account.isControl,
      openingDebit: round2(op.debit),
      openingCredit: round2(op.credit),
      debit: round2(mv.debit),
      credit: round2(mv.credit),
      net: round2(mv.debit - mv.credit),
      closing: round2(op.debit - op.credit + mv.debit - mv.credit),
    };
  };

  for (const [accountId, mv] of movement) {
    const account = byId.get(accountId);
    if (account) rows.push(build(account, mv));
  }
  if (opts.includeZero) {
    for (const account of list) {
      if (movement.has(account.id)) continue;
      rows.push(build(account, { debit: 0, credit: 0 }));
    }
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const debit = round2(rows.reduce((s, x) => s + x.debit, 0));
  const credit = round2(rows.reduce((s, x) => s + x.credit, 0));
  return {
    rows,
    totals: { debit, credit, balanced: debit > 0 && Math.abs(debit - credit) < 0.005 },
  };
}

/**
 * Group rollups: a group account shows the total of its own postings plus its
 * descendants' OWN figures — every amount counted exactly once, so the footer of
 * a rolled-up trial balance still equals Σdr = Σcr.
 */
export function rollupByTree(
  rows: AccountBalanceRow[],
  tree: ReturnType<typeof buildTree>,
): AccountBalanceRow[] {
  const own = new Map(rows.map((r) => [r.accountId, r]));
  const out = new Map(rows.map((r) => [r.accountId, { ...r }]));
  for (const [id, members] of tree.descendants) {
    if (members.length <= 1) continue;
    const ownMembers = members.map((m) => own.get(m)).filter(Boolean) as AccountBalanceRow[];
    if (ownMembers.length === 0) continue;
    const seed = out.get(id) ?? ownMembers[0];
    out.set(id, {
      ...seed,
      openingDebit: round2(ownMembers.reduce((s, m) => s + m.openingDebit, 0)),
      openingCredit: round2(ownMembers.reduce((s, m) => s + m.openingCredit, 0)),
      debit: round2(ownMembers.reduce((s, m) => s + m.debit, 0)),
      credit: round2(ownMembers.reduce((s, m) => s + m.credit, 0)),
      net: round2(ownMembers.reduce((s, m) => s + m.net, 0)),
      closing: round2(ownMembers.reduce((s, m) => s + m.closing, 0)),
    });
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export interface LedgerLine {
  entryId: string;
  entryNo: number | null;
  businessDate: string;
  memo: string | null;
  sourceType: string;
  sourceId: string;
  isReversal: boolean;
  lineNo: number;
  accountId: string;
  debit: number;
  credit: number;
  runningBalance: number;
  branchId: string | null;
  warehouseId: string | null;
  representativeId: string | null;
}

/** R-01 General Ledger / R-07 Account Statement for one account. */
export async function accountLedger(
  trx: Trx,
  tenantId: string,
  accountId: string,
  range: DateRange,
): Promise<{ opening: number; lines: LedgerLine[]; closing: number }> {
  const [account] = await trx
    .select({ id: accounts.id, code: accounts.code, nameAr: accounts.nameAr })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)))
    .limit(1);
  if (!account) return { opening: 0, lines: [], closing: 0 };
  const opening = (await openingBalances(trx, tenantId, range.from, [accountId])).get(accountId) ?? {
    debit: 0,
    credit: 0,
  };
  const conditions = [
    eq(journalEntries.tenantId, tenantId),
    eq(journalEntries.status, "posted"),
    eq(journalLines.accountId, accountId),
  ];
  if (range.from) conditions.push(gte(journalEntries.businessDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.businessDate, range.to));
  const rows = await trx
    .select({
      entryId: journalEntries.id,
      entryNo: journalEntries.entryNo,
      businessDate: journalEntries.businessDate,
      memo: journalEntries.memo,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      reversalOf: journalEntries.reversalOf,
      lineNo: journalLines.lineNo,
      debit: journalLines.debit,
      credit: journalLines.credit,
      branchId: journalLines.branchId,
      warehouseId: journalLines.warehouseId,
      representativeId: journalLines.representativeId,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.businessDate), asc(journalEntries.entryNo), asc(journalLines.lineNo));

  let running = round2(opening.debit - opening.credit);
  const lines: LedgerLine[] = rows.map((row) => {
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    running = round2(running + debit - credit);
    return {
      entryId: row.entryId,
      entryNo: row.entryNo,
      businessDate: row.businessDate,
      memo: row.memo,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      isReversal: Boolean(row.reversalOf),
      lineNo: Number(row.lineNo),
      accountId,
      debit: round2(debit),
      credit: round2(credit),
      runningBalance: running,
      branchId: row.branchId,
      warehouseId: row.warehouseId,
      representativeId: row.representativeId,
    };
  });
  return { opening: round2(opening.debit - opening.credit), lines, closing: running };
}

/** Signed closing balance of one account as of a date (debit-positive). */
export async function accountClosingBalance(
  trx: Trx,
  tenantId: string,
  accountId: string,
  range: DateRange,
): Promise<number> {
  const mv = (await movementBalances(trx, tenantId, range, [accountId])).get(accountId) ?? {
    debit: 0,
    credit: 0,
  };
  const op = (await openingBalances(trx, tenantId, range.from, [accountId])).get(accountId) ?? {
    debit: 0,
    credit: 0,
  };
  return round2(op.debit - op.credit + mv.debit - mv.credit);
}

/**
 * R-03/R-04 building blocks: signed totals per account type.
 * P&L accounts report range movement; balance-sheet accounts report the closing
 * position (opening + movement). Sign convention: assets/expenses positive
 * (debit), liabilities/equity/revenue positive (credit).
 */
export async function balancesByType(
  trx: Trx,
  tenantId: string,
  range: DateRange,
): Promise<Record<string, number>> {
  const tb = await trialBalance(trx, tenantId, range, { includeZero: true });
  const out: Record<string, number> = { asset: 0, liability: 0, equity: 0, revenue: 0, expense: 0 };
  for (const row of tb.rows) {
    const creditPositive = row.type === "liability" || row.type === "equity" || row.type === "revenue";
    const movement = creditPositive ? row.net * -1 : row.net;
    const closing = creditPositive ? row.closing * -1 : row.closing;
    const value = row.type === "revenue" || row.type === "expense" ? movement : closing;
    out[row.type] = round2((out[row.type] ?? 0) + value);
  }
  return out;
}
