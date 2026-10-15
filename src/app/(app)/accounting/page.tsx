import { desc, eq, and } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import {
  accounts as accountsTable,
  fiscalPeriods,
  journalEntries,
  journalLines,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { listMappingsWithStatus } from "@/modules/accounting/mappings";
import { todayBusinessDate } from "@/modules/shared/dates";
import { JournalForm } from "./journal-form";
import { MappingRow } from "./mapping-row";
import { ActionButton } from "@/components/forms/action-button";
import {
  postJournalAction,
  reverseJournalAction,
  closePeriodAction,
  reopenPeriodAction,
} from "@/modules/accounting/actions";
import { Lock, Unlock, FileEdit, CheckCircle2, RotateCcw } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "المحاسبة" };

export default async function AccountingPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "accounting.journal.view");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const accts = await trx
      .select({ id: accountsTable.id, code: accountsTable.code, nameAr: accountsTable.nameAr, type: accountsTable.type, isGroup: accountsTable.isGroup })
      .from(accountsTable)
      .where(eq(accountsTable.tenantId, ctx.tenant!.id))
      .orderBy(accountsTable.code);
    const periods = await trx
      .select()
      .from(fiscalPeriods)
      .where(eq(fiscalPeriods.tenantId, ctx.tenant!.id))
      .orderBy(fiscalPeriods.startDate);
    const journals = await trx
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.tenantId, ctx.tenant!.id))
      .orderBy(desc(journalEntries.createdAt))
      .limit(60);
    const totals = (await trx.execute(sql`
      select entry_id, sum(debit)::text as dr, sum(credit)::text as cr
      from journal_lines group by entry_id
    `)) as unknown as { rows: { entry_id: string; dr: string; cr: string }[] };
    const reversed = (await trx.execute(sql`
      select reversal_of from journal_entries where reversal_of is not null
    `)) as unknown as { rows: { reversal_of: string }[] };
    const mappings = await listMappingsWithStatus(trx, ctx.tenant!.id);
    return { accts, periods, journals, totals, reversed: new Set(reversed.rows.map((r) => r.reversal_of)), mappings };
  });

  const totalsByEntry = new Map(data.totals.rows.map((r) => [r.entry_id, r]));
  const canPost = ctx.permissions.has("accounting.journal.post");
  const canReverse = ctx.permissions.has("accounting.journal.reverse");
  const canManagePeriods = ctx.permissions.has("accounting.period.manage");
  const flatAccounts = data.accts.filter((a) => !a.isGroup).map((a) => ({ id: a.id, code: a.code, name: a.nameAr }));
  const postableAccounts = flatAccounts;
  const typeLabel = (ty: string) =>
    ({ asset: t.accounting.typeAsset, liability: t.accounting.typeLiability, equity: t.accounting.typeEquity, revenue: t.accounting.typeRevenue, expense: t.accounting.typeExpense })[ty] ?? ty;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">{t.accounting.title}</h1>

      {/* Journals */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{t.accounting.journals}</h2>
        {canPost && (
          <JournalForm t={t} accounts={postableAccounts} defaultDate={todayBusinessDate()} errors={errorsFlat} />
        )}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">{t.accounting.entryNo}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.accounting.date}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.accounting.memo}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.accounting.source}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.accounting.totalDebit}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.status}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.journals.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">{t.accounting.noJournals}</td></tr>
              )}
              {data.journals.map((j) => {
                const totals = totalsByEntry.get(j.id);
                return (
                  <tr key={j.id} className="border-b border-border/60 last:border-0">
                    <td className="tnum px-4 py-2.5 font-semibold" dir="ltr">{j.entryNo ?? "—"}</td>
                    <td className="tnum px-4 py-2.5" dir="ltr">{j.businessDate}</td>
                    <td className="max-w-56 truncate px-4 py-2.5">{j.memo ?? "—"}</td>
                    <td className="px-4 py-2.5 text-xs text-muted" dir="ltr">{j.sourceType}</td>
                    <td className="tnum px-4 py-2.5 text-end font-medium" dir="ltr">{totals ? Number(totals.dr).toFixed(2) : "—"}</td>
                    <td className="px-4 py-2.5">
                      {j.status === "draft" ? (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-warning-soft px-2 py-1 text-[11px] font-semibold text-warning">
                          <FileEdit className="h-3.5 w-3.5" /> {t.accounting.statusDraft}
                        </span>
                      ) : data.reversed.has(j.id) ? (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-surface-3 px-2 py-1 text-[11px] font-semibold text-muted">
                          <RotateCcw className="h-3.5 w-3.5" /> {t.accounting.reversedBadge}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-success-soft px-2 py-1 text-[11px] font-semibold text-success">
                          <CheckCircle2 className="h-3.5 w-3.5" /> {t.accounting.statusPosted}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      {j.status === "draft" && canPost && (
                        <ActionButton label={t.accounting.post} action={postJournalAction}
                          fields={{ entryId: j.id }} confirmText={t.accounting.postConfirm}
                          okText={t.accounting.journalPosted} errors={errorsFlat} />
                      )}
                      {j.status === "posted" && !data.reversed.has(j.id) && canReverse && (
                        <ActionButton label={t.accounting.reverse} action={reverseJournalAction}
                          fields={{ entryId: j.id }} confirmText={t.accounting.reverseConfirm}
                          variant="ghost" okText={t.accounting.journalReversed} errors={errorsFlat} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Posting mappings */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t.accounting.mappings}</h2>
        <p className="text-sm text-muted">{t.accounting.mappingsHint}</p>
        <div className="card overflow-x-auto p-2">
          <table className="w-full">
            <tbody>
              {data.mappings.map((m) => (
                <MappingRow key={m.key} mapKey={m.key} nameAr={m.nameAr} accountId={m.accountId}
                  accounts={flatAccounts} saveLabel={t.accounting.mappingsSave}
                  missingLabel={t.accounting.mappingsMissing} savedLabel={t.accounting.mappingSaved} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Periods */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t.accounting.periods}</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">الفترة</th>
                <th className="px-4 py-2.5 text-start font-medium">من</th>
                <th className="px-4 py-2.5 text-start font-medium">إلى</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.status}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.periods.map((p) => (
                <tr key={p.id} className="border-b border-border/60 last:border-0">
                  <td className="tnum px-4 py-2.5 font-semibold" dir="ltr">{p.name}</td>
                  <td className="tnum px-4 py-2.5" dir="ltr">{p.startDate}</td>
                  <td className="tnum px-4 py-2.5" dir="ltr">{p.endDate}</td>
                  <td className="px-4 py-2.5">
                    {p.status === "open" ? (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-success-soft px-2 py-1 text-[11px] font-semibold text-success">
                        <Unlock className="h-3.5 w-3.5" /> {t.accounting.periodOpen}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-danger-soft px-2 py-1 text-[11px] font-semibold text-danger">
                        <Lock className="h-3.5 w-3.5" /> {t.accounting.periodClosed}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {canManagePeriods &&
                      (p.status === "open" ? (
                        <ActionButton label={t.accounting.closePeriod} action={closePeriodAction}
                          fields={{ periodId: p.id }} confirmText={t.accounting.closeConfirm}
                          variant="danger" okText="✓" errors={errorsFlat} />
                      ) : (
                        <ActionButton label={t.accounting.reopenPeriod} action={reopenPeriodAction}
                          fields={{ periodId: p.id }} confirmText={t.accounting.reopenConfirm}
                          variant="ghost" okText="✓" errors={errorsFlat} />
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* COA */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t.accounting.coa}</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">{t.accounting.coaCode}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.accounting.coaName}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.accounting.coaType}</th>
              </tr>
            </thead>
            <tbody>
              {data.accts.map((a) => (
                <tr key={a.id} className="border-b border-border/60 last:border-0">
                  <td className="tnum px-4 py-2 font-semibold" dir="ltr">{a.code}</td>
                  <td className="px-4 py-2" style={{ paddingInlineStart: `${(a.code.length >= 4 ? 2 : a.code.length > 1 ? 1 : 0) * 1.25}rem` }}>
                    <span className={a.isGroup ? "font-bold" : ""}>
                      {a.nameAr}
                      {a.isGroup && <span className="ms-2 text-[10px] font-normal text-muted">({t.accounting.groupAccount})</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">{typeLabel(a.type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
