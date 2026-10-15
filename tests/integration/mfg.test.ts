/**
 * Manufacturing (Phase 5): consumption at actual lot cost, computed output
 * cost incl. labor/overhead, scrap normal/abnormal, zero-cost block (D-009),
 * genealogy/recall, production clearing reconciliation (FR-024…028).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;
const RUN = Math.random().toString(36).slice(2, 8);
const TODAY = "2026-06-15";

describe.skipIf(!DB)("manufacturing — production cost engine & genealogy", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  let tenantA = "";
  let actorId = "";
  let mainWh = "";
  let outProductId = "";
  let flourId = "";
  let sugarId = "";
  let bomId = "";
  let orderId = "";
  const ctx = () => ({ tenantId: tenantA, actorId });

  async function scalar(q: ReturnType<typeof sql>): Promise<string> {
    const r = (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
    return Object.values(r.rows[0])[0] as string;
  }

  async function balance(productId: string): Promise<number> {
    const v = await scalar(sql`
      select coalesce(on_hand, 0)::text from stock_balances
      where tenant_id = ${tenantA} and warehouse_id = ${mainWh} and product_id = ${productId}
    `);
    return Number(v);
  }

  async function clearingBalance(order: string): Promise<number> {
    const v = await scalar(sql`
      select coalesce(sum(l.debit::numeric - l.credit::numeric), 0)::text
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      where a.code = '5201' and l.tenant_id = ${tenantA}
        and ((e.source_type = 'production' and e.source_id = ${order})
          or (e.source_type = 'production_component' and e.source_id = ${order})
          or (e.source_type = 'production_scrap' and e.source_id = ${order}))
    `);
    return Number(v);
  }

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    ({ withTenant } = await import("@/modules/shared/db-context"));
    ({ newId } = await import("@/modules/shared/ids"));
    tenantA = await scalar(sql`select id from tenants order by created_at asc limit 1`);
    actorId = await scalar(sql`select id from users where tenant_id = ${tenantA} order by created_at asc limit 1`);
    mainWh = await scalar(sql`select id from warehouses where tenant_id = ${tenantA} and code = 'MAIN'`);
    // RUN-scoped lot-tracked materials (deterministic costs regardless of
    // parallel-suite consumption of the seeded catalogue)
    const unitKg = await scalar(sql`select id from units where tenant_id = ${tenantA} and code = 'KG'`);
    const { receiveStock } = await import("@/modules/inventory/stock");
    for (const [sku, name, cost, batch, qty, expiry] of [
      [`FLOUR-${RUN}`, "دقيق تصنيع اختبار", "8.50", `MF-FLOUR-${RUN}`, "300", "2027-07-01"],
      [`SUGAR-${RUN}`, "سكر تصنيع اختبار", "11.00", `MF-SUGAR-${RUN}`, "200", "2027-08-01"],
    ] as const) {
      await db.execute(sql`
        insert into products (id, tenant_id, sku, name_ar, stock_unit_id, track_lots, track_expiry, tax_category, sale_price)
        values (${newId()}, ${tenantA}, ${sku}, ${name}, ${unitKg}, true, true, 'standard', '0')
      `);
      const pid = await scalar(sql`select id from products where tenant_id = ${tenantA} and sku = ${sku}`);
      if (sku.startsWith("FLOUR")) flourId = pid;
      else sugarId = pid;
      await withTenant(tenantA, (trx) =>
        receiveStock(trx, ctx(), {
          warehouseId: mainWh, productId: pid, qty, unitCost: cost,
          lot: { batchNo: batch, expiryDate: expiry },
          businessDate: TODAY, sourceType: "test", sourceId: newId(), effectKind: `recv-${batch}`, lineRef: RUN,
        }),
      );
    }

    // fresh finished product (lot+expiry tracked)
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, track_lots, track_expiry, tax_category, sale_price)
      select ${newId()}, ${tenantA}, ${"MFG-" + RUN}, 'مشروب إنتاجي اختباري', u.id, true, true, 'standard', '9.00'
      from units u where u.tenant_id = ${tenantA} and u.code = 'EA' limit 1
    `);
    outProductId = await scalar(sql`select id from products where tenant_id = ${tenantA} and sku = ${"MFG-" + RUN}`);
  });

  it("BOM versioning: per batch 10 EA ← flour 2 KG + sugar 0.5 KG; new version deactivates prior", async () => {
    const { createBom } = await import("@/modules/manufacturing/production");
    bomId = await withTenant(tenantA, (trx) =>
      createBom(trx, ctx(), {
        productId: outProductId,
        name: "وصفة المشروب الاختبارية",
        yieldQty: "10",
        lines: [
          { productId: flourId, qty: "2" },
          { productId: sugarId, qty: "0.5" },
        ],
      }),
    );
    const v1 = await scalar(sql`select version from boms where id = ${bomId}`);
    expect(Number(v1)).toBe(1);

    const bom2 = await withTenant(tenantA, (trx) =>
      createBom(trx, ctx(), {
        productId: outProductId,
        name: "وصفة محسّنة",
        yieldQty: "10",
        lines: [{ productId: flourId, qty: "1.8" }],
      }),
    );
    const v2 = await scalar(sql`select active from boms where id = ${bomId}`);
    expect(String(v2)).toBe("false");
    const v2v = await scalar(sql`select version from boms where id = ${bom2}`);
    expect(Number(v2v)).toBe(2);
    // keep order flows on the original BOM
  });

  it("full cycle: consume at actual lot cost, components, computed output cost, clearing nets to zero", async () => {
    const p = await import("@/modules/manufacturing/production");

    const flourBefore = await balance(flourId);
    const sugarBefore = await balance(sugarId);

    orderId = await withTenant(tenantA, (trx) =>
      p.createProductionOrder(trx, ctx(), {
        bomId,
        plannedQty: "100", // 10 batches → flour 20, sugar 5
        fromWarehouseId: mainWh,
        toWarehouseId: mainWh,
        businessDate: TODAY,
      }),
    );

    await withTenant(tenantA, (trx) => p.startProduction(trx, ctx(), orderId));

    expect(await balance(flourId)).toBeCloseTo(flourBefore - 20, 4);
    expect(await balance(sugarId)).toBeCloseTo(sugarBefore - 5, 4);
    // clearing holds consumption value: 20×8.5 + 5×11 = 225.00
    expect(await clearingBalance(orderId)).toBeCloseTo(225, 2);

    const [c1, c2] = await Promise.all([
      withTenant(tenantA, (trx) => p.startProduction(trx, ctx(), orderId)),
      withTenant(tenantA, (trx) => p.startProduction(trx, ctx(), orderId)),
    ]).then(() => [null, null]);
    void c1; void c2;
    // concurrent double-start stays idempotent (no double consumption)
    expect(await clearingBalance(orderId)).toBeCloseTo(225, 2);

    await withTenant(tenantA, (trx) => p.addCostComponent(trx, ctx(), orderId, { kind: "labor", description: "أجور", amount: "30" }));
    await withTenant(tenantA, (trx) => p.addCostComponent(trx, ctx(), orderId, { kind: "overhead", description: "غير مباشرة", amount: "45" }));
    expect(await clearingBalance(orderId)).toBeCloseTo(300, 2);

    const completion = await withTenant(tenantA, (trx) =>
      p.completeProduction(trx, ctx(), orderId, { outputQty: "95", expiryDate: "2026-12-31" }),
    );
    // unit cost = 300 / 95 = 3.1579 (4dp HALF_UP)
    expect(Number(completion.unitCost)).toBeCloseTo(3.1579, 4);
    expect(Number(await balance(outProductId))).toBeCloseTo(95, 4);

    // clearing nets to zero after output (basis moved into finished goods)
    expect(await clearingBalance(orderId)).toBeCloseTo(0, 2);

    // variance view: yield 95%, materials 225, components 75
    const variance = await withTenant(tenantA, (trx) => p.orderVariance(trx, tenantA, orderId));
    expect(variance.yieldPct).toBe("95.00");
    expect(Number(variance.matActualValue)).toBeCloseTo(225, 2);
    expect(Number(variance.componentsValue)).toBeCloseTo(75, 2);
    expect(Number(variance.output!.unitCost)).toBeCloseTo(3.1579, 4);
  });

  it("scrap: normal removes value from clearing into scrap expense (never into unit cost silently)", async () => {
    const p = await import("@/modules/manufacturing/production");
    const order2 = await withTenant(tenantA, (trx) =>
      p.createProductionOrder(trx, ctx(), {
        bomId, plannedQty: "10", fromWarehouseId: mainWh, toWarehouseId: mainWh, businessDate: TODAY,
      }),
    );
    await withTenant(tenantA, (trx) => p.startProduction(trx, ctx(), order2));
    expect(await clearingBalance(order2)).toBeCloseTo(22.5, 2); // flour 2×8.5 + sugar 0.5×11

    await withTenant(tenantA, (trx) =>
      p.recordScrap(trx, ctx(), order2, { productId: flourId, qty: "0.5", abnormal: false }),
    );
    // scrap value = 0.5 × 8.5 = 4.25 → clearing 22.5 − 4.25 = 18.25
    expect(await clearingBalance(order2)).toBeCloseTo(18.25, 2);
    const scrapAcct = await scalar(sql`select id from accounts where tenant_id = ${tenantA} and code = '5104'`);
    const scrapDr = await scalar(sql`
      select sum(l.debit::numeric)::text from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where e.source_type = 'production_scrap' and e.source_id = ${order2} and l.account_id = ${scrapAcct}
    `);
    expect(Number(scrapDr)).toBeCloseTo(4.25, 2);

    await withTenant(tenantA, (trx) =>
      p.completeProduction(trx, ctx(), order2, { outputQty: "9", expiryDate: "2026-12-31" }),
    );
    // unit cost = 18.25 / 9 = 2.0278
    const [out] = (
      (await db.execute(sql`select unit_cost::text from production_outputs where order_id = ${order2}`)) as unknown as {
        rows: { unit_cost: string }[];
      }
    ).rows;
    expect(Number(out.unit_cost)).toBeCloseTo(2.0278, 4);
  });

  it("zero-cost basis blocks completion with a configuration error (D-009/FR-028)", async () => {
    const p = await import("@/modules/manufacturing/production");
    const { isDomainError } = await import("@/modules/shared/result");
    const order3 = await withTenant(tenantA, (trx) =>
      p.createProductionOrder(trx, ctx(), {
        bomId, plannedQty: "10", fromWarehouseId: mainWh, toWarehouseId: mainWh, businessDate: TODAY,
      }),
    );
    await withTenant(tenantA, (trx) => p.startProduction(trx, ctx(), order3));
    // scrap everything → basis ≈ 0
    await withTenant(tenantA, (trx) =>
      p.recordScrap(trx, ctx(), order3, { productId: flourId, qty: "2", abnormal: true }),
    );
    await withTenant(tenantA, (trx) =>
      p.recordScrap(trx, ctx(), order3, { productId: sugarId, qty: "0.5", abnormal: true }),
    );
    const basis = await clearingBalance(order3);
    expect(Math.abs(basis)).toBeLessThan(0.01);

    const err = await withTenant(tenantA, (trx) =>
      p.completeProduction(trx, ctx(), order3, { outputQty: "10", expiryDate: "2026-12-31" }),
    ).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect(err.kind).toBe("ConfigurationError");
    expect(err.messageKey).toBe("errors.productionCostMissing");

    const completed = await scalar(sql`select status from production_orders where id = ${order3}`);
    expect(completed).toBe("in_progress"); // still not completed — no silent posting
  });

  it("genealogy & recall: output lot → consumed material lots → sales/customer chain (FR-027)", async () => {
    const p = await import("@/modules/manufacturing/production");
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const custId = await scalar(sql`select id from customers where tenant_id = ${tenantA} and code = 'CUST-002'`);

    const outputLotId = await scalar(sql`
      select lot_id from production_outputs where order_id = ${orderId} limit 1
    `);
    expect(outputLotId).toBeTruthy();

    // sell 3 units of the finished lot
    await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId: custId,
        warehouseId: mainWh,
        businessDate: TODAY,
        isCredit: false,
        lines: [{ productId: outProductId, qtyBase: "3" }],
      }, false),
    );

    const trace = await withTenant(tenantA, (trx) => p.traceRecall(trx, tenantA, outputLotId));
    expect(trace.output).not.toBeNull();
    expect(trace.order).not.toBeNull();

    const batchNos = trace.consumedLots.map((l) => String(l.batch_no));
    expect(batchNos).toContain(`MF-FLOUR-${RUN}`);
    expect(batchNos).toContain(`MF-SUGAR-${RUN}`);

    expect(trace.sales.length).toBeGreaterThan(0);
    expect(stringifyContains(trace.sales, "النور")).toBe(true);

    // forward trace from the flour lot reaches this drink lot too
    const flourLotId = await scalar(sql`
      select id from stock_lots where tenant_id = ${tenantA} and batch_no = ${'MF-FLOUR-' + RUN} limit 1
    `);
    const consumedIn = await scalar(sql`
      select count(distinct sl.source_id)::text from stock_ledger sl
      where sl.tenant_id = ${tenantA} and sl.lot_id = ${flourLotId}
        and sl.source_type = 'production' and sl.effect_kind = 'consume'
    `);
    expect(Number(consumedIn)).toBeGreaterThan(0);
  });

  it("completed orders are immutable at DB level", async () => {
    const err: unknown = await db
      .execute(sql`update production_orders set planned_qty = planned_qty + 1 where id = ${orderId}`)
      .catch((x: unknown) => x);
    expect(err instanceof Error).toBe(true);
  });
});

function stringifyContains(rows: unknown[], needle: string): boolean {
  return JSON.stringify(rows).includes(needle);
}
