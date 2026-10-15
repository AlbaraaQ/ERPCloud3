import { desc, eq, and } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import { sql } from "drizzle-orm";
import {
  boms as bomsTable,
  bomLines,
  productionOrders,
  productionCostComponents,
  productionConsumptions,
  warehouses as warehousesTable,
  products as productsTable,
} from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
import { BomForm, OrderForm, OrderCard, RecallTrace, type OrderView, type PlanLine } from "./mfg-forms";
import { Factory } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "التصنيع" };

export default async function ManufacturingPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "production.manage");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const bomRows = await trx
      .select({
        id: bomsTable.id,
        name: bomsTable.name,
        version: bomsTable.version,
        yieldQty: bomsTable.yieldQty,
        active: bomsTable.active,
        productName: productsTable.nameAr,
      })
      .from(bomsTable)
      .innerJoin(productsTable, eq(bomsTable.productId, productsTable.id))
      .where(eq(bomsTable.tenantId, ctx.tenant!.id))
      .orderBy(desc(bomsTable.createdAt));

    const bomLineRows = await trx
      .select({
        bomLineId: bomLines.id,
        bomId: bomLines.bomId,
        productName: productsTable.nameAr,
        qty: bomLines.qty,
      })
      .from(bomLines)
      .innerJoin(productsTable, eq(bomLines.productId, productsTable.id))
      .where(eq(bomLines.tenantId, ctx.tenant!.id));

    const orderRows = await trx
      .select({
        id: productionOrders.id,
        orderNo: productionOrders.orderNo,
        status: productionOrders.status,
        plannedQty: productionOrders.plannedQty,
        outputQty: productionOrders.outputQty,
        bomId: productionOrders.bomId,
        productName: productsTable.nameAr,
      })
      .from(productionOrders)
      .innerJoin(productsTable, eq(productionOrders.productId, productsTable.id))
      .where(eq(productionOrders.tenantId, ctx.tenant!.id))
      .orderBy(desc(productionOrders.createdAt))
      .limit(15);

    const compRows = await trx
      .select()
      .from(productionCostComponents)
      .where(eq(productionCostComponents.tenantId, ctx.tenant!.id));

    const consumeRows = await trx
      .select({
        orderId: productionConsumptions.orderId,
        bomLineId: productionConsumptions.bomLineId,
        productId: productionConsumptions.productId,
        productName: productsTable.nameAr,
        plannedQty: productionConsumptions.plannedQty,
        actualQty: productionConsumptions.actualQty,
        costValue: productionConsumptions.costValue,
      })
      .from(productionConsumptions)
      .innerJoin(productsTable, eq(productionConsumptions.productId, productsTable.id))
      .where(eq(productionConsumptions.tenantId, ctx.tenant!.id));

    const whs = await trx
      .select({ id: warehousesTable.id, name: warehousesTable.name, type: warehousesTable.type })
      .from(warehousesTable)
      .where(eq(warehousesTable.tenantId, ctx.tenant!.id));
    const prods = await trx
      .select({ id: productsTable.id, nameAr: productsTable.nameAr, sku: productsTable.sku })
      .from(productsTable)
      .where(and(eq(productsTable.tenantId, ctx.tenant!.id), eq(productsTable.active, true)));

    // clearing balances per order (GL-driven)
    const clearingRows = (await trx.execute(sql`
      select e.source_id,
        sum(l.debit::numeric - l.credit::numeric)::text as balance
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      where a.code = '5201' and l.tenant_id = ${ctx.tenant!.id}
        and e.source_type in ('production', 'production_component', 'production_scrap')
      group by e.source_id
    `)) as unknown as { rows: { source_id: string; balance: string }[] };

    const outputs = (await trx.execute(sql`
      select order_id, unit_cost::text, qty::text from production_outputs
      where tenant_id = ${ctx.tenant!.id}
    `)) as unknown as { rows: { order_id: string; unit_cost: string; qty: string }[] };

    return { bomRows, bomLineRows, orderRows, compRows, consumeRows, whs, prods, clearingRows, outputs };
  });

  const clearingByOrder = new Map(data.clearingRows.rows.map((r) => [r.source_id, Number(r.balance)]));
  const outputByOrder = new Map(data.outputs.rows.map((r) => [r.order_id, r]));
  const componentsByOrder = new Map<string, number>();
  for (const c of data.compRows) {
    componentsByOrder.set(c.orderId, (componentsByOrder.get(c.orderId) ?? 0) + Number(c.amount));
  }
  const consumedByOrder = new Map<string, number>();
  for (const c of data.consumeRows) {
    consumedByOrder.set(c.orderId, (consumedByOrder.get(c.orderId) ?? 0) + Number(c.costValue));
  }

  const orderViews: OrderView[] = data.orderRows.map((o) => {
    const out = outputByOrder.get(o.id);
    return {
      id: o.id,
      orderNo: o.orderNo,
      status: o.status,
      plannedQty: o.plannedQty,
      outputQty: o.outputQty,
      productName: o.productName,
      consumedValue: consumedByOrder.get(o.id) ?? 0,
      componentsValue: componentsByOrder.get(o.id) ?? 0,
      clearing: clearingByOrder.get(o.id) ?? 0,
      yieldPct: out ? ((Number(out.qty) / Number(o.plannedQty)) * 100).toFixed(2) : null,
      outputCost: out ? Number(out.unit_cost).toFixed(4) : null,
    };
  });

  const bomInfo = (bomId: string) => data.bomRows.find((b) => b.id === bomId);
  const planLinesFor = (bomId: string, plannedQty: string): PlanLine[] => {
    const bom = bomInfo(bomId);
    if (!bom) return [];
    const batches = Number(plannedQty) / Number(bom.yieldQty);
    return data.bomLineRows
      .filter((l) => l.bomId === bomId)
      .map((l) => ({ bomLineId: l.bomLineId, productName: l.productName, plannedQty: (Number(l.qty) * batches).toString(), actualQty: (Number(l.qty) * batches).toString() }));
  };

  return (
    <div className="space-y-8">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <Factory className="h-6 w-6 text-primary" /> {t.mfg.title}
      </h1>

      <div className="grid gap-5 lg:grid-cols-2">
        <BomForm t={t} errors={errorsFlat}
          products={data.prods.map((p) => ({ id: p.id, label: `${p.sku} — ${p.nameAr}` }))} />
        <OrderForm t={t} errors={errorsFlat}
          boms={data.bomRows.filter((b) => b.active).map((b) => ({ id: b.id, label: `${b.name} (v${b.version})` }))}
          warehouses={data.whs.filter((w) => w.type !== "in_transit" && w.type !== "quarantine").map((w) => ({ id: w.id, label: w.name }))} />
      </div>

      {/* BOMs list */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t.mfg.boms}</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">الاسم</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.mfg.product}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.mfg.version}</th>
                <th className="px-4 py-2.5 text-end font-medium">{t.mfg.yield}</th>
                <th className="px-4 py-2.5 text-center font-medium">{t.inventory.status}</th>
              </tr>
            </thead>
            <tbody>
              {data.bomRows.map((b) => (
                <tr key={b.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-2.5 font-medium">{b.name}</td>
                  <td className="px-4 py-2.5">{b.productName}</td>
                  <td className="tnum px-4 py-2.5" dir="ltr">v{b.version}</td>
                  <td className="tnum px-4 py-2.5 text-end" dir="ltr">{Number(b.yieldQty)}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${b.active ? "bg-success-soft text-success" : "bg-surface-3 text-muted"}`}>
                      {b.active ? t.mfg.activeV : t.mfg.inactiveV}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Orders */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t.mfg.orders}</h2>
        {orderViews.length === 0 && <div className="card p-8 text-center text-sm text-muted">{t.mfg.noOrder}</div>}
        {orderViews.map((o) => (
          <OrderCard key={o.id} t={t} errors={errorsFlat} order={o}
            planLines={planLinesFor(data.orderRows.find((r) => r.id === o.id)!.bomId, o.plannedQty)}
            components={data.compRows.filter((c) => c.orderId === o.id).map((c) => ({ id: c.id, kind: c.kind, description: c.description, amount: c.amount }))}
            consumables={data.consumeRows.filter((c) => c.orderId === o.id).map((c) => ({
              bomLineId: c.bomLineId, productId: c.productId, productName: c.productName,
              plannedQty: c.plannedQty, actualQty: c.actualQty, costValue: c.costValue,
            }))} />
        ))}
      </section>

      <RecallTrace t={t} errors={errorsFlat} />
    </div>
  );
}
