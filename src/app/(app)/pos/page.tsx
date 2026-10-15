import { desc, eq, and } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import {
  customers as customersTable,
  customerPrices,
  products as productsTable,
  warehouses as warehousesTable,
  treasuryAccounts,
  stockBalances,
} from "@/db/schema";
import { eq as eqCol } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { PosScreen } from "./pos-screen";
import { hasPermission } from "@/modules/shared/context";

export const dynamic = "force-dynamic";
export const metadata = { title: "نقطة البيع" };

export default async function PosPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "sales.pos.use");

  const locale = await getLocale();
  const t = getDict(locale);

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const customers = await trx
      .select({
        id: customersTable.id,
        code: customersTable.code,
        nameAr: customersTable.nameAr,
        phone: customersTable.phone,
        creditLimit: customersTable.creditLimit,
        paymentTermsDays: customersTable.paymentTermsDays,
        creditHold: customersTable.creditHold,
      })
      .from(customersTable)
      .where(and(eq(customersTable.tenantId, ctx.tenant!.id), eq(customersTable.active, true)))
      .orderBy(customersTable.code);

    const prods = await trx
      .select({
        id: productsTable.id,
        sku: productsTable.sku,
        barcode: productsTable.barcode,
        nameAr: productsTable.nameAr,
        salePrice: productsTable.salePrice,
        minPrice: productsTable.minPrice,
        maxPrice: productsTable.maxPrice,
        taxCategory: productsTable.taxCategory,
      })
      .from(productsTable)
      .where(and(eq(productsTable.tenantId, ctx.tenant!.id), eq(productsTable.active, true)));

    const balances = await trx
      .select({
        productId: stockBalances.productId,
        onHand: stockBalances.onHand,
        warehouseId: stockBalances.warehouseId,
      })
      .from(stockBalances)
      .where(eqCol(stockBalances.tenantId, ctx.tenant!.id));

    const prices = await trx
      .select({
        customerId: customerPrices.customerId,
        productId: customerPrices.productId,
        price: customerPrices.price,
      })
      .from(customerPrices)
      .where(eq(customerPrices.tenantId, ctx.tenant!.id));

    const whs = await trx
      .select({ id: warehousesTable.id, name: warehousesTable.name, type: warehousesTable.type })
      .from(warehousesTable)
      .where(and(eq(warehousesTable.tenantId, ctx.tenant!.id), eq(warehousesTable.active, true)));

    const treasuries = await trx
      .select({ id: treasuryAccounts.id, name: treasuryAccounts.name, kind: treasuryAccounts.kind })
      .from(treasuryAccounts)
      .where(and(eq(treasuryAccounts.tenantId, ctx.tenant!.id), eq(treasuryAccounts.active, true)));

    return {
      customers,
      prods,
      balances,
      prices,
      whs: whs.filter((w) => w.type !== "in_transit" && w.type !== "quarantine"),
      defaultWh: whs.find((w) => w.type === "main")?.id ?? whs[0]?.id,
      treasuries,
    };
  });

  const errorsFlat = t.errors as unknown as Record<string, string>;

  return (
    <PosScreen
      t={t}
      errors={errorsFlat}
      customers={data.customers.map((c) => ({
        id: c.id,
        label: `${c.code} — ${c.nameAr}`,
        creditHold: c.creditHold,
        creditLimit: c.creditLimit,
        terms: c.paymentTermsDays,
      }))}
      products={data.prods.map((p) => ({
        id: p.id,
        sku: p.sku,
        barcode: p.barcode ?? "",
        name: p.nameAr,
        price: p.salePrice,
        min: p.minPrice,
        max: p.maxPrice,
      }))}
      customerPrices={Object.fromEntries(
        data.prices.map((cp) => [`${cp.customerId}:${cp.productId}`, cp.price]),
      )}
      balances={Object.fromEntries(
        data.balances.map((b) => [`${b.warehouseId}:${b.productId}`, Number(b.onHand)]),
      )}
      warehouses={data.whs.map((w) => ({ id: w.id, name: w.name }))}
      defaultWarehouseId={data.defaultWh ?? ""}
      treasuries={data.treasuries}
      canPost={hasPermission(ctx, "sales.invoice.post")}
      canOverride={hasPermission(ctx, "sales.price.override")}
    />
  );
}
