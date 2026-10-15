/**
 * Account resolution for reports.
 *
 * Reports must never hard-code a control account id: tenants configure their chart
 * through the posting-mapping contract (`accounting/coa.MAPPING_KEYS` +
 * `postingMappings`). Every ledger comparison therefore resolves the account by
 * MAPPING KEY first and only falls back to the conventional code — so a remapped
 * tenant still reconciles, and a missing mapping is visible instead of silently
 * comparing against the wrong account.
 */

import { and, eq, sql } from "drizzle-orm";
import { accounts, postingMappings } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";

export interface ResolvedAccount {
  id: string;
  code: string;
  nameAr: string;
  /** mapping key when the account came from the contract, otherwise the fallback code used */
  via: string;
}

export async function resolveReportAccount(
  trx: Trx,
  tenantId: string,
  mappingKey: string,
  fallbackCode: string,
): Promise<ResolvedAccount | null> {
  const [mapped] = await trx
    .select({ id: accounts.id, code: accounts.code, nameAr: accounts.nameAr })
    .from(postingMappings)
    .innerJoin(accounts, eq(accounts.id, postingMappings.accountId))
    .where(and(eq(postingMappings.tenantId, tenantId), eq(postingMappings.key, mappingKey)))
    .limit(1);
  if (mapped) return { ...mapped, via: mappingKey };

  const [byCode] = await trx
    .select({ id: accounts.id, code: accounts.code, nameAr: accounts.nameAr })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, fallbackCode)))
    .limit(1);
  return byCode ? { ...byCode, via: fallbackCode } : null;
}

/** Signed ledger balance (debit-positive) of a mapped account within a range. */
export async function mappedAccountBalance(
  trx: Trx,
  tenantId: string,
  mappingKey: string,
  fallbackCode: string,
  range: { from?: string; to?: string },
): Promise<{ account: ResolvedAccount | null; balance: number }> {
  const account = await resolveReportAccount(trx, tenantId, mappingKey, fallbackCode);
  if (!account) return { account: null, balance: 0 };
  const rows = await trx.execute(sql`
    select coalesce(sum(l.debit - l.credit), 0)::text as balance
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    where e.tenant_id = ${tenantId} and e.status = 'posted' and l.account_id = ${account.id}
      ${range.from ? sql`and e.business_date >= ${range.from}` : sql``}
      ${range.to ? sql`and e.business_date <= ${range.to}` : sql``}
  `);
  const row = (rows as unknown as { rows: { balance: string }[] }).rows[0];
  return { account, balance: Math.round(Number(row?.balance ?? 0) * 100) / 100 };
}
