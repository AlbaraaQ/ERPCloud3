import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission, hasPermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import {
  treasuryAccounts as treasuryTable,
  expenses as expensesTable,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { ActionButton } from "@/components/forms/action-button";
import { approveExpenseAction, rejectExpenseAction } from "@/modules/cash/actions";
import { ExpenseForm } from "./expense-form";
import { Wallet, ReceiptText, Landmark } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "النقدية والبنوك" };

export default async function CashPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "cash.manage");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const treasuries = await trx
      .select()
      .from(treasuryTable)
      .where(eq(treasuryTable.tenantId, ctx.tenant!.id));
    const exps = await trx
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.tenantId, ctx.tenant!.id))
      .orderBy(desc(expensesTable.createdAt))
      .limit(40);
    const balances = (await trx.execute(sql`
      select a.code,
        coalesce(sum(l.debit::numeric - l.credit::numeric), 0)::text as bal
      from accounts a
      left join journal_lines l on l.account_id = a.id
      where a.tenant_id = ${ctx.tenant!.id} and a.code in ('1101', '1102')
      group by a.code
    `)) as unknown as { rows: { code: string; bal: string }[] };
    const pendingCards = (await trx.execute(sql`
      select rl.id, rl.amount::text, rl.reference, r.receipt_no, r.business_date, c.name_ar as customer_name
      from receipt_lines rl
      join receipts r on r.id = rl.receipt_id
      join customers c on c.id = r.customer_id
      where rl.tenant_id = ${ctx.tenant!.id} and rl.settlement_status = 'pending'
      order by r.created_at asc limit 30
    `)) as unknown as { rows: any[] };
    return { treasuries, exps, balances: balances.rows, pendingCards: pendingCards.rows };
  });

  const balOf = (code: string, kind: string) =>
    kind === "cash" && code === "1101" ? true : kind === "bank" && code === "1102";
  const canCreate = hasPermission(ctx, "expenses.create");
  const canApprove = hasPermission(ctx, "expenses.approve");
  const statusTone = (s: string) =>
    s === "approved" ? "bg-success-soft text-success" : s === "rejected" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning";
  const statusLabel = (s: string) =>
    s === "approved" ? t.cashPg.stApproved : s === "rejected" ? t.cashPg.stRejected : t.cashPg.stPending;
  const methodLabel = (m: string) =>
    m === "cash" ? t.pos.cash : m === "bank_transfer" ? t.pos.bank : m === "card" ? t.pos.card : t.pos.other;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">{t.cashPg.title}</h1>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.treasuries.map((x) => {
          const gl = data.balances.find((b) => balOf(b.code, x.kind));
          return (
            <div key={x.id} className="card flex items-start justify-between p-5">
              <div>
                <p className="font-semibold">{x.name}</p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                  {x.kind === "cash" ? <Wallet className="h-3.5 w-3.5" /> : <Landmark className="h-3.5 w-3.5" />}
                  {x.kind === "cash" ? t.cashPg.cash : t.cashPg.bank}
                  <span dir="ltr" className="ms-1 opacity-60">{x.code}</span>
                </p>
              </div>
              <div className="text-end">
                <p className="text-[11px] text-muted">{t.cashPg.balance}</p>
                <p className="tnum text-xl font-bold text-primary" dir="ltr">
                  {gl ? Number(gl.bal).toFixed(2) : "0.00"}
                </p>
              </div>
            </div>
          );
        })}
      </section>

      {canCreate && (
        <ExpenseForm t={t} errors={errorsFlat}
          treasuries={data.treasuries.map((x) => ({ id: x.id, label: `${x.name} (${x.kind === "cash" ? t.cashPg.cash : t.cashPg.bank})` }))} />
      )}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ReceiptText className="h-5 w-5 text-primary" /> {t.cashPg.expenses}
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">{t.cashPg.expenseNo}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.cashPg.category}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.cashPg.note}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.cashPg.date}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.cashPg.method}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.cashPg.amount}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.cashPg.expenses}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.exps.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-muted">{t.common.empty}</td></tr>
              )}
              {data.exps.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0">
                  <td className="tnum px-4 py-2.5" dir="ltr">{e.expenseNo ?? "—"}</td>
                  <td className="px-4 py-2.5 font-medium">{e.category}</td>
                  <td className="max-w-44 truncate px-4 py-2.5 text-muted">{e.note ?? "—"}</td>
                  <td className="tnum px-4 py-2.5" dir="ltr">{e.businessDate}</td>
                  <td className="px-4 py-2.5 text-muted">{methodLabel(e.method)}</td>
                  <td className="tnum px-4 py-2.5 text-end font-semibold" dir="ltr">{Number(e.amount).toFixed(2)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${statusTone(e.status)}`}>
                      {statusLabel(e.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {e.status === "pending" && canApprove && (
                      <span className="inline-flex gap-2">
                        <ActionButton label={t.cashPg.approve} action={approveExpenseAction}
                          fields={{ expenseId: e.id }} confirmText={t.cashPg.approveConfirm}
                          okText="✓" errors={errorsFlat} />
                        <ActionButton label={t.cashPg.reject} action={rejectExpenseAction}
                          fields={{ expenseId: e.id, reason: "مرفوض من الشاشة" }}
                          variant="danger" okText="✓" errors={errorsFlat} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
