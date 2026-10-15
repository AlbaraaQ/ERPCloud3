import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import {
  products as productsTable,
  units as unitsTable,
  warehouses as warehousesTable,
  stockBalances,
  transfers as transfersTable,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { ReceiptForm, ProductForm, DispatchForm } from "./forms";
import { ActionButton } from "@/components/forms/action-button";
import { acceptTransferAction, closeTransferAction } from "@/modules/inventory/actions";
import { Boxes, Truck, Package, Warehouse as WarehouseIcon } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "المخزون" };

export default async function InventoryPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "inventory.view");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const prods = await trx
      .select({
        id: productsTable.id,
        sku: productsTable.sku,
        nameAr: productsTable.nameAr,
        barcode: productsTable.barcode,
        salePrice: productsTable.salePrice,
        trackLots: productsTable.trackLots,
        trackExpiry: productsTable.trackExpiry,
        active: productsTable.active,
        unit: unitsTable.nameAr,
      })
      .from(productsTable)
      .leftJoin(unitsTable, eq(productsTable.stockUnitId, unitsTable.id))
      .where(eq(productsTable.tenantId, ctx.tenant!.id))
      .orderBy(productsTable.sku);
    const whs = await trx
      .select()
      .from(warehousesTable)
      .where(eq(warehousesTable.tenantId, ctx.tenant!.id))
      .orderBy(warehousesTable.code);
    const unitsList = await trx
      .select({ id: unitsTable.id, nameAr: unitsTable.nameAr })
      .from(unitsTable)
      .where(eq(unitsTable.tenantId, ctx.tenant!.id));
    const bals = (await trx.execute(sql`
      select b.on_hand::text as on_hand, b.avg_cost::text as avg_cost,
             w.name as warehouse_name, p.name_ar as product_name, p.sku, u.name_ar as unit_name
      from stock_balances b
      join warehouses w on w.id = b.warehouse_id
      join products p on p.id = b.product_id
      left join units u on u.id = p.stock_unit_id
      where b.tenant_id = ${ctx.tenant!.id} and b.on_hand <> 0
      order by w.code, p.sku
    `)) as unknown as { rows: { on_hand: string; avg_cost: string; warehouse_name: string; product_name: string; sku: string; unit_name: string | null }[] };
    const trs = await trx
      .select()
      .from(transfersTable)
      .where(eq(transfersTable.tenantId, ctx.tenant!.id))
      .orderBy(desc(transfersTable.createdAt))
      .limit(20);
    const trLines = (await trx.execute(sql`
      select l.transfer_id, l.qty_dispatched::text, l.qty_received::text, p.name_ar, p.sku
      from transfer_lines l join products p on p.id = l.product_id
      where l.tenant_id = ${ctx.tenant!.id}
    `)) as unknown as { rows: { transfer_id: string; qty_dispatched: string; qty_received: string; name_ar: string; sku: string }[] };
    const whName = new Map(whs.map((w) => [w.id, w.name]));
    return { prods, whs, unitsList, bals: bals.rows, trs, trLines: trLines.rows, whName };
  });

  const canAdjust = ctx.permissions.has("inventory.adjust");
  const canDispatch = ctx.permissions.has("inventory.transfer.dispatch");
  const canReceive = ctx.permissions.has("inventory.transfer.receive");
  const canProduct = ctx.permissions.has("catalog.products.manage");
  const productOpts = data.prods.filter((p) => p.active).map((p) => ({ id: p.id, label: `${p.sku} — ${p.nameAr}` }));
  const whOpts = data.whs.filter((w) => w.active && w.type !== "in_transit" && w.type !== "quarantine").map((w) => ({ id: w.id, label: w.name }));
  const statusLabel = (s: string) =>
    ({ draft: t.inventory.stDraft, dispatched: t.inventory.stDispatched, partially_received: t.inventory.stPartial, received: t.inventory.stReceived, disputed: t.inventory.stDisputed, closed: t.inventory.stClosed, cancelled: t.inventory.stCancelled })[s] ?? s;
  const statusTone = (s: string) =>
    s === "received" || s === "closed" ? "bg-success-soft text-success"
    : s === "dispatched" ? "bg-info-soft text-info"
    : s === "disputed" ? "bg-danger-soft text-danger"
    : s === "partially_received" ? "bg-warning-soft text-warning"
    : "bg-surface-3 text-muted";

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">{t.inventory.title}</h1>

      {/* Balances */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Boxes className="h-5 w-5 text-primary" /> {t.inventory.balances}
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.warehouse}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.product}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.inventory.onHand}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.inventory.avgCost}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.inventory.value}</th>
              </tr>
            </thead>
            <tbody>
              {data.bals.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">{t.common.empty}</td></tr>
              )}
              {data.bals.map((b, i) => (
                <tr key={i} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-2.5">{b.warehouse_name}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{b.product_name}</span>
                    <span className="ms-2 text-xs text-muted" dir="ltr">{b.sku}</span>
                  </td>
                  <td className="tnum px-4 py-2.5 text-end font-semibold" dir="ltr">
                    {Number(b.on_hand).toLocaleString("en-US")} {b.unit_name ?? ""}
                  </td>
                  <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(b.avg_cost).toFixed(2)}</td>
                  <td className="tnum px-4 py-2.5 text-end font-medium" dir="ltr">
                    {(Number(b.on_hand) * Number(b.avg_cost)).toFixed(2)} {t.common.sar}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canAdjust && (
        <ReceiptForm t={t} errors={errorsFlat} warehouses={whOpts} products={productOpts} />
      )}

      {/* Transfers */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Truck className="h-5 w-5 text-primary" /> {t.inventory.transfers}
        </h2>
        {canDispatch && <DispatchForm t={t} errors={errorsFlat} warehouses={whOpts} products={productOpts} />}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">#</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.from}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.to}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.product}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.inventory.dispatchedQty}/{t.inventory.receivedQty}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.status}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.trs.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">{t.common.empty}</td></tr>
              )}
              {data.trs.map((tr) => {
                const lines = data.trLines.filter((l) => l.transfer_id === tr.id);
                const full = lines.length > 0 && lines.every((l) => Number(l.qty_received) >= Number(l.qty_dispatched));
                return (
                  <tr key={tr.id} className="border-b border-border/60 last:border-0">
                    <td className="tnum px-4 py-2.5 font-semibold" dir="ltr">{tr.transferNo ?? "—"}</td>
                    <td className="px-4 py-2.5">{data.whName.get(tr.fromWarehouseId) ?? "—"}</td>
                    <td className="px-4 py-2.5">{data.whName.get(tr.toWarehouseId) ?? "—"}</td>
                    <td className="px-4 py-2.5">{lines.map((l) => l.name_ar).join("، ") || "—"}</td>
                    <td className="tnum px-4 py-2.5 text-end" dir="ltr">
                      {lines.map((l) => `${l.qty_dispatched}/${l.qty_received}`).join(" · ") || "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${statusTone(tr.status)}`}>
                        {statusLabel(tr.status)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      {(tr.status === "dispatched" || tr.status === "partially_received") && canReceive && !full && (
                        <ActionButton label={t.inventory.acceptAll} action={acceptTransferAction}
                          fields={{ transferId: tr.id }} confirmText={t.inventory.acceptConfirm}
                          okText={t.inventory.accepted} errors={errorsFlat} />
                      )}
                      {tr.status === "received" && canDispatch && (
                        <ActionButton label={t.inventory.closeTransfer} action={closeTransferAction}
                          fields={{ transferId: tr.id }} variant="ghost" okText="✓" errors={errorsFlat} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Products */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Package className="h-5 w-5 text-primary" /> {t.inventory.products}
        </h2>
        {canProduct && (
          <ProductForm t={t} errors={errorsFlat}
            units={data.unitsList.map((u) => ({ id: u.id, label: u.nameAr }))} />
        )}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.sku}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.name}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.barcode}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.unit}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.inventory.price}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.inventory.status}</th>
              </tr>
            </thead>
            <tbody>
              {data.prods.map((p) => (
                <tr key={p.id} className="border-b border-border/60 last:border-0">
                  <td className="tnum px-4 py-2.5 font-semibold" dir="ltr">{p.sku}</td>
                  <td className="px-4 py-2.5">{p.nameAr}</td>
                  <td className="tnum px-4 py-2.5 text-muted" dir="ltr">{p.barcode ?? "—"}</td>
                  <td className="px-4 py-2.5">{p.unit ?? "—"}</td>
                  <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(p.salePrice).toFixed(2)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${p.active ? "bg-success-soft text-success" : "bg-surface-3 text-muted"}`}>
                      {p.active ? t.inventory.active : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Warehouses */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <WarehouseIcon className="h-5 w-5 text-primary" /> {t.inventory.warehousesList}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.whs.map((w) => (
            <div key={w.id} className="card flex items-center justify-between p-4">
              <div>
                <p className="font-semibold">{w.name}</p>
                <p className="text-xs text-muted" dir="ltr">{w.code} · {w.type}</p>
              </div>
              <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${w.active ? "bg-success-soft text-success" : "bg-surface-3 text-muted"}`}>
                {w.active ? t.inventory.active : "—"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
