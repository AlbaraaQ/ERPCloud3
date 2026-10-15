import { desc, eq, and } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission, hasPermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import { sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { ActionButton } from "@/components/forms/action-button";
import { postDraftInvoiceAction, deleteDraftInvoiceAction, settleReceiptLineAction } from "@/modules/sales/actions";
import { ReceiptForm, ReturnInline } from "./ui";
import { FileText, BadgeDollarSign, CreditCard } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "المبيعات" };

export default async function SalesPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "sales.invoice.view");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const invoices = (await trx.execute(sql`
      select i.id, i.invoice_no, i.invoice_type, i.business_status, i.business_date, i.due_date,
             i.is_credit, i.total::text, coalesce(c.name_ar, 'عميل عابر') as customer_name, i.customer_id,
             coalesce((select sum(a.amount) from allocations a where a.invoice_id = i.id), 0)::text as allocated,
             (i.total - coalesce((select sum(a.amount) from allocations a where a.invoice_id = i.id), 0))::text as outstanding
      from sales_invoices i
      left join customers c on c.id = i.customer_id
      where i.tenant_id = ${ctx.tenant!.id}
      order by i.created_at desc
      limit 60
    `)) as unknown as { rows: any[] };

    const customersExposure = (await trx.execute(sql`
      select c.id, c.name_ar,
        (coalesce((select sum(total) from sales_invoices where tenant_id = c.tenant_id and customer_id = c.id and business_status='posted' and invoice_type='sale'),0)
       - coalesce((select sum(total) from sales_invoices where tenant_id = c.tenant_id and customer_id = c.id and business_status='posted' and invoice_type='sale_return'),0)
       - coalesce((select sum(a.amount) from allocations a join sales_invoices i2 on i2.id = a.invoice_id where i2.customer_id = c.id and i2.invoice_type='sale'),0))::text as exposure,
        (coalesce((select sum(advance_amount) from receipts where tenant_id = c.tenant_id and customer_id = c.id and status='posted'),0)
       - coalesce((select sum(a.amount) from allocations a join sales_invoices i3 on i3.id = a.invoice_id and i3.customer_id = c.id where a.is_advance_application = true),0))::text as advance
      from customers c where c.tenant_id = ${ctx.tenant!.id} and c.active = true
      order by c.code
    `)) as unknown as { rows: any[] };

    const receipts = (await trx.execute(sql`
      select r.id, r.receipt_no, r.business_date, r.total_amount::text, r.allocated_amount::text,
             r.advance_amount::text, c.name_ar as customer_name
      from receipts r join customers c on c.id = r.customer_id
      where r.tenant_id = ${ctx.tenant!.id}
      order by r.created_at desc limit 20
    `)) as unknown as { rows: any[] };

    const pendingCards = (await trx.execute(sql`
      select rl.id, rl.amount::text, rl.reference, r.receipt_no, r.business_date, c.name_ar as customer_name
      from receipt_lines rl
      join receipts r on r.id = rl.receipt_id
      join customers c on c.id = r.customer_id
      where rl.tenant_id = ${ctx.tenant!.id} and rl.settlement_status = 'pending'
      order by r.created_at asc limit 30
    `)) as unknown as { rows: any[] };

    const returnLines = (await trx.execute(sql`
      select l.id, l.invoice_id, l.qty_base::text, p.name_ar,
        coalesce((select sum(rl.qty_base) from sales_invoice_lines rl
          join sales_invoices ri on ri.id = rl.invoice_id
          where ri.original_invoice_id = l.invoice_id and rl.original_line_id = l.id
            and ri.business_status = 'posted'), 0)::text as returned
      from sales_invoice_lines l
      join products p on p.id = l.product_id
      join sales_invoices i on i.id = l.invoice_id
      where i.tenant_id = ${ctx.tenant!.id} and i.business_status = 'posted' and i.invoice_type = 'sale'
    `)) as unknown as { rows: any[] };

    return {
      invoices: invoices.rows,
      customers: customersExposure.rows,
      receipts: receipts.rows,
      pendingCards: pendingCards.rows,
      returnLines: returnLines.rows,
    };
  });

  const canReceive = hasPermission(ctx, "sales.receipts.manage");
  const canPost = hasPermission(ctx, "sales.invoice.post");
  const canReturn = hasPermission(ctx, "sales.return.create");
  const canSettle = hasPermission(ctx, "cash.manage");

  const openInvoices = data.invoices.filter(
    (i) => i.business_status === "posted" && i.invoice_type === "sale" && Number(i.outstanding) > 0.0001,
  );
  const drafts = data.invoices.filter((i) => i.business_status === "draft");

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t.salesPg.title}</h1>
        {hasPermission(ctx, "sales.pos.use") && (
          <Link href="/pos" className="btn btn-primary">فتح نقطة البيع</Link>
        )}
      </div>

      {/* customer exposures */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.customers.map((c) => (
          <div key={c.id} className="card p-4">
            <p className="font-semibold">{c.name_ar}</p>
            <div className="mt-2 flex justify-between text-sm">
              <span className="text-muted">{t.salesPg.exposure}</span>
              <span className={`tnum font-bold ${Number(c.exposure) > 0 ? "text-warning" : "text-success"}`} dir="ltr">
                {Number(c.exposure).toFixed(2)}
              </span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-muted">{t.salesPg.advance}</span>
              <span className="tnum font-semibold" dir="ltr">{Number(c.advance).toFixed(2)}</span>
            </div>
          </div>
        ))}
      </section>

      {/* open invoices + receipt form */}
      {canReceive && (
        <ReceiptForm t={t} errors={errorsFlat}
          customers={data.customers.map((c) => ({ id: c.id, label: c.name_ar }))}
          openInvoices={openInvoices.map((i) => ({
            id: i.id, customerId: i.customer_id,
            label: `#${i.invoice_no} — ${i.customer_name} — ${Number(i.outstanding).toFixed(2)}`,
            outstanding: i.outstanding,
          }))} />
      )}

      {/* drafts */}
      {drafts.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <FileText className="h-5 w-5 text-warning" /> {t.accounting.statusDraft}
          </h2>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                  <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.customer}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.date}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t.salesPg.total}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {drafts.map((i) => (
                  <tr key={i.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2.5">{i.customer_name}</td>
                    <td className="tnum px-4 py-2.5" dir="ltr">{i.business_date}</td>
                    <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(i.total).toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-end">
                      <span className="inline-flex gap-2">
                        {canPost && (
                          <ActionButton label={t.salesPg.postDraft} action={postDraftInvoiceAction}
                            fields={{ invoiceId: i.id }} confirmText={t.accounting.postConfirm}
                            okText={t.accounting.journalPosted} errors={errorsFlat} />
                        )}
                        <ActionButton label={t.salesPg.deleteDraft} action={deleteDraftInvoiceAction}
                          fields={{ invoiceId: i.id }} confirmText={t.salesPg.deleteDraftConfirm}
                          variant="danger" okText="✓" errors={errorsFlat} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* invoices list */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <BadgeDollarSign className="h-5 w-5 text-primary" /> {t.salesPg.recentInvoices}
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.invoiceNo}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.type}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.customer}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.date}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.due}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.salesPg.total}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.salesPg.outstanding}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.invoices.filter((i) => i.business_status === "posted").map((i) => (
                <tr key={i.id} className="border-b border-border/60 last:border-0">
                  <td className="tnum px-4 py-2.5 font-semibold" dir="ltr">{i.invoice_no}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-lg px-2 py-0.5 text-[11px] font-semibold ${i.invoice_type === "sale_return" ? "bg-info-soft text-info" : "bg-success-soft text-success"}`}>
                      {i.invoice_type === "sale_return" ? t.salesPg.typeReturn : t.salesPg.typeSale}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{i.customer_name}</td>
                  <td className="tnum px-4 py-2.5" dir="ltr">{i.business_date}</td>
                  <td className="tnum px-4 py-2.5 text-muted" dir="ltr">{i.due_date ?? "—"}</td>
                  <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(i.total).toFixed(2)}</td>
                  <td className="tnum px-4 py-2.5 text-end font-semibold" dir="ltr">
                    {i.invoice_type === "sale" ? Number(i.outstanding).toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {canReturn && i.invoice_type === "sale" && (
                      <ReturnInline t={t} errors={errorsFlat} invoiceId={i.id}
                        lines={data.returnLines
                          .filter((l) => l.invoice_id === i.id && Number(l.qty_base) - Number(l.returned) > 0.000001)
                          .map((l) => ({
                            lineId: l.id,
                            productName: l.name_ar,
                            sold: l.qty_base,
                            returned: l.returned,
                          }))} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* pending card settlements */}
      {data.pendingCards.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CreditCard className="h-5 w-5 text-warning" /> {t.salesPg.cardSettlements}
          </h2>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                  <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.receipt}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.customer}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.reference}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t.salesPg.amount}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t.salesPg.status}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {data.pendingCards.map((c) => (
                  <tr key={c.id} className="border-b border-border/60 last:border-0">
                    <td className="tnum px-4 py-2.5" dir="ltr">#{c.receipt_no}</td>
                    <td className="px-4 py-2.5">{c.customer_name}</td>
                    <td className="px-4 py-2.5 text-muted" dir="ltr">{c.reference ?? "—"}</td>
                    <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(c.amount).toFixed(2)}</td>
                    <td className="px-4 py-2.5">
                      <span className="rounded-lg bg-warning-soft px-2 py-1 text-[11px] font-semibold text-warning">{t.salesPg.pending}</span>
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      {canSettle && (
                        <ActionButton label={t.salesPg.settle} action={settleReceiptLineAction}
                          fields={{ receiptLineId: c.id }} okText={t.salesPg.settled} errors={errorsFlat} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
