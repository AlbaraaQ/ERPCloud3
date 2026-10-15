import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission, hasPermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import {
  suppliers as suppliersTable,
  warehouses as warehousesTable,
  products as productsTable,
  treasuryAccounts as treasuryTable,
  purchaseInvoices as purchasesTable,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { ActionButton } from "@/components/forms/action-button";
import { postPurchaseAction } from "@/modules/purchasing/actions";
import { PurchaseForm, SupplierPaymentForm } from "./purchase-form";
import { ShoppingBag, Banknote } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "المشتريات" };

export default async function PurchasingPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "purchasing.manage");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const suppliers = await trx
      .select({ id: suppliersTable.id, nameAr: suppliersTable.nameAr })
      .from(suppliersTable)
      .where(eq(suppliersTable.tenantId, ctx.tenant!.id));
    const whs = await trx
      .select({ id: warehousesTable.id, name: warehousesTable.name, type: warehousesTable.type })
      .from(warehousesTable)
      .where(eq(warehousesTable.tenantId, ctx.tenant!.id));
    const prods = await trx
      .select({ id: productsTable.id, sku: productsTable.sku, nameAr: productsTable.nameAr })
      .from(productsTable)
      .where(eq(productsTable.tenantId, ctx.tenant!.id));
    const treasuries = await trx
      .select({ id: treasuryTable.id, name: treasuryTable.name, kind: treasuryTable.kind })
      .from(treasuryTable)
      .where(eq(treasuryTable.tenantId, ctx.tenant!.id));
    const invoices = await trx
      .select()
      .from(purchasesTable)
      .where(eq(purchasesTable.tenantId, ctx.tenant!.id))
      .orderBy(desc(purchasesTable.createdAt))
      .limit(40);
    const outstandingRows = (await trx.execute(sql`
      select i.id, i.invoice_no, i.business_date, s.name_ar, s.id as supplier_id,
        (i.total - coalesce((select sum(a.amount) from supplier_allocations a where a.purchase_invoice_id = i.id), 0))::text as outstanding,
        i.total::text
      from purchase_invoices i join suppliers s on s.id = i.supplier_id
      where i.tenant_id = ${ctx.tenant!.id} and i.status = 'posted'
        and (i.total - coalesce((select sum(a.amount) from supplier_allocations a where a.purchase_invoice_id = i.id), 0)) > 0
      order by i.business_date
    `)) as unknown as { rows: { id: string; invoice_no: number; business_date: string; name_ar: string; supplier_id: string; outstanding: string; total: string }[] };
    return { suppliers, whs, prods, treasuries, invoices, open: outstandingRows.rows };
  });

  const whOpts = data.whs.filter((w) => w.type !== "in_transit" && w.type !== "quarantine")
    .map((w) => ({ id: w.id, label: w.name }));
  const statusLabel = (s: string) => (s === "posted" ? t.purchasing.stPosted : t.purchasing.stDraft);
  const statusTone = (s: string) => (s === "posted" ? "bg-success-soft text-success" : "bg-warning-soft text-warning");

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">{t.purchasing.title}</h1>

      <PurchaseForm t={t} errors={errorsFlat}
        suppliers={data.suppliers.map((s) => ({ id: s.id, label: s.nameAr }))}
        warehouses={whOpts}
        products={data.prods.map((p) => ({ id: p.id, label: `${p.sku} — ${p.nameAr}` }))} />

      {/* open supplier balances */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Banknote className="h-5 w-5 text-primary" /> {t.purchasing.openForPayment}
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">#</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.purchasing.supplier}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.purchasing.date}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.purchasing.total}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.purchasing.outstanding}</th>
              </tr>
            </thead>
            <tbody>
              {data.open.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">{t.common.empty}</td></tr>
              )}
              {data.open.map((o) => (
                <tr key={o.id} className="border-b border-border/60 last:border-0">
                  <td className="tnum px-4 py-2.5" dir="ltr">{o.invoice_no}</td>
                  <td className="px-4 py-2.5">{o.name_ar}</td>
                  <td className="tnum px-4 py-2.5" dir="ltr">{o.business_date}</td>
                  <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(o.total).toFixed(2)}</td>
                  <td className="tnum px-4 py-2.5 text-end font-semibold text-warning" dir="ltr">{Number(o.outstanding).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <SupplierPaymentForm t={t} errors={errorsFlat}
          suppliers={data.suppliers.map((s) => ({ id: s.id, label: s.nameAr }))}
          treasuries={data.treasuries.map((x) => ({ id: x.id, label: x.name }))}
          openInvoices={data.open.map((o) => ({
            id: o.id,
            supplierId: o.supplier_id,
            label: `#${o.invoice_no} — ${Number(o.outstanding).toFixed(2)}`,
          }))} />
      </section>

      {/* invoices */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShoppingBag className="h-5 w-5 text-primary" /> {t.purchasing.invoices}
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">#</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.purchasing.supplierRef}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.purchasing.date}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.purchasing.total}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.purchasing.status}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.invoices.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted">{t.common.empty}</td></tr>
              )}
              {data.invoices.map((i) => (
                <tr key={i.id} className="border-b border-border/60 last:border-0">
                  <td className="tnum px-4 py-2.5 font-semibold" dir="ltr">{i.invoiceNo ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted" dir="ltr">{i.supplierRef ?? "—"}</td>
                  <td className="tnum px-4 py-2.5" dir="ltr">{i.businessDate}</td>
                  <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(i.total).toFixed(2)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${statusTone(i.status)}`}>
                      {statusLabel(i.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {i.status === "draft" && (
                      <ActionButton label={t.purchasing.post} action={postPurchaseAction}
                        fields={{ invoiceId: i.id }} confirmText={t.accounting.postConfirm}
                        okText="✓" errors={errorsFlat} />
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
