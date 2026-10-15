import { and, eq, gt } from "drizzle-orm";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant } from "@/modules/shared/db-context";
import { assertDevice, custodyForUser } from "@/modules/vansales/sync";
import {
  products as productsTable,
  customers as customersTable,
  customerPrices,
  stockBalances,
  salesInvoices,
  transfers as transfersTable,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Delta pull per scope. Client provides its stored cursors; server returns
 * rows newer than cursor + the new cursor (= max seen timestamp).
 */
export async function GET(req: Request) {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const url = new URL(req.url);
  const deviceId = url.searchParams.get("deviceId") ?? "";
  let cursors: Record<string, string> = {};
  try {
    cursors = JSON.parse(url.searchParams.get("cursors") ?? "{}");
  } catch {
    return Response.json({ error: "invalid_cursors" }, { status: 400 });
  }
  const since = (scope: string) => cursors[scope] ?? "1970-01-01T00:00:00.000Z";

  try {
    return await withTenant(ctx.tenant.id, async (trx) => {
      await assertDevice(trx, ctx.tenant!.id, deviceId, ctx.userId!);
      const custody = await custodyForUser(trx, ctx.tenant!.id, ctx.userId!);

      const prodRows = await trx
        .select({
          id: productsTable.id, sku: productsTable.sku, barcode: productsTable.barcode,
          nameAr: productsTable.nameAr, salePrice: productsTable.salePrice,
          minPrice: productsTable.minPrice, maxPrice: productsTable.maxPrice,
          trackLots: productsTable.trackLots, trackExpiry: productsTable.trackExpiry,
          updatedAt: productsTable.updatedAt,
        })
        .from(productsTable)
        .where(
          and(
            eq(productsTable.tenantId, ctx.tenant!.id),
            eq(productsTable.active, true),
            gt(productsTable.updatedAt, new Date(since("products"))),
          ),
        );

      const custRows = await trx
        .select({
          id: customersTable.id, code: customersTable.code, nameAr: customersTable.nameAr,
          phone: customersTable.phone, creditLimit: customersTable.creditLimit,
          paymentTermsDays: customersTable.paymentTermsDays, creditHold: customersTable.creditHold,
          taxNumber: customersTable.taxNumber,
          updatedAt: customersTable.updatedAt,
        })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.tenantId, ctx.tenant!.id),
            eq(customersTable.active, true),
            gt(customersTable.updatedAt, new Date(since("customers"))),
          ),
        );

      const priceRows = await trx
        .select({
          customerId: customerPrices.customerId,
          productId: customerPrices.productId,
          price: customerPrices.price,
        })
        .from(customerPrices)
        .where(eq(customerPrices.tenantId, ctx.tenant!.id));

      const stockRows = custody
        ? await trx
            .select({ productId: stockBalances.productId, onHand: stockBalances.onHand, avgCost: stockBalances.avgCost })
            .from(stockBalances)
            .where(
              and(
                eq(stockBalances.tenantId, ctx.tenant!.id),
                eq(stockBalances.warehouseId, custody.id),
              ),
            )
        : [];

      const invRows = await trx
        .select({
          id: salesInvoices.id,
          invoiceNo: salesInvoices.invoiceNo,
          businessStatus: salesInvoices.businessStatus,
          taxStatus: salesInvoices.taxStatus,
          total: salesInvoices.total,
          businessDate: salesInvoices.businessDate,
          clientOpId: salesInvoices.clientOpId,
          createdAt: salesInvoices.createdAt,
        })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, ctx.tenant!.id),
            eq(salesInvoices.salespersonUserId, ctx.userId!),
            gt(salesInvoices.createdAt, new Date(since("invoices"))),
          ),
        );

      const transferRows = custody
        ? await trx
            .select({
              id: transfersTable.id,
              transferNo: transfersTable.transferNo,
              status: transfersTable.status,
              businessDate: transfersTable.businessDate,
            })
            .from(transfersTable)
            .where(
              and(
                eq(transfersTable.tenantId, ctx.tenant!.id),
                eq(transfersTable.toWarehouseId, custody.id),
              ),
            )
        : [];

      const transferLinesRow = custody && transferRows.length > 0
        ? await trx.execute(sql`
            select l.transfer_id, l.id as line_id, p.name_ar, p.sku,
                   l.qty_dispatched::text, l.qty_received::text, l.discrepancy_reason
            from transfer_lines l join products p on p.id = l.product_id
            where l.tenant_id = ${ctx.tenant!.id}
          `)
        : ({ rows: [] } as unknown as { rows: unknown[] });

      const now = new Date().toISOString();
      return Response.json({
        serverTime: now,
        me: {
          userId: ctx.userId,
          name: ctx.userName,
          custodyWarehouseId: custody?.id ?? null,
          custodyWarehouseName: custody?.name ?? null,
        },
        scopes: {
          products: { rows: prodRows, cursor: latest(prodRows.map((r) => r.updatedAt), since("products")) },
          customers: { rows: custRows, cursor: latest(custRows.map((r) => r.updatedAt), since("customers")) },
          prices: { rows: priceRows, cursor: now },
          stock: { rows: stockRows.map((r) => ({ ...r, warehouseId: custody?.id })), cursor: now },
          invoices: { rows: invRows, cursor: latest(invRows.map((r) => r.createdAt), since("invoices")) },
          transfers: {
            rows: transferRows,
            lines: (transferLinesRow as unknown as { rows: unknown[] }).rows,
            cursor: now,
          },
        },
      });
    });
  } catch (e) {
    if (isDomainError(e)) {
      const status = e.messageKey === "errors.deviceNotRegistered" ? 409 : 403;
      return Response.json({ error: e.messageKey }, { status });
    }
    logger.error({ err: e }, "sync pull failed");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

function latest(dates: (Date | null | undefined)[], fallback: string): string {
  const max = dates
    .filter((d): d is Date => d instanceof Date)
    .reduce((acc, d) => (d.getTime() > acc ? d.getTime() : acc), 0);
  return max > 0 ? new Date(max).toISOString() : fallback;
}
