/**
 * Inventory foundations (Phase 2) — WAC/FEFO (D-009), negative stock (D-008),
 * concurrency (INV-15), ledger reconciliation (INV-06), transfers (INV-07),
 * append-only ledger (INV-05).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("inventory — stock engine invariants", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  let tenantA = "";
  let actorId = "";
  let mainWh = "";
  let unitEa = "";
  const ctx = () => ({ tenantId: tenantA, actorId });
  const today = "2026-03-10";
  /** run-unique product suffix so re-runs start from clean balances */
  const RUN = Math.random().toString(36).slice(2, 8);
  const createdSkus: string[] = [];

  async function productIdBySku(sku: string): Promise<string> {
    const r = (await db.execute(
      sql`select id from products where tenant_id = ${tenantA} and sku = ${sku}`,
    )) as unknown as { rows: { id: string }[] };
    return r.rows[0].id;
  }

  async function makeProduct(baseSku: string, opts: { trackLots?: boolean; trackExpiry?: boolean } = {}): Promise<string> {
    const sku = `${baseSku}-${RUN}`;
    createdSkus.push(sku);
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, track_lots, track_expiry, sale_price)
      values (${newId()}, ${tenantA}, ${sku}, ${"منتج اختبار " + sku}, ${unitEa}, ${opts.trackLots ?? false}, ${opts.trackExpiry ?? false}, '0')
      on conflict (tenant_id, sku) do nothing
    `);
    const r = (await db.execute(
      sql`select id from products where tenant_id = ${tenantA} and sku = ${sku}`,
    )) as unknown as { rows: { id: string }[] };
    return r.rows[0].id;
  }

  async function balanceOf(warehouseId: string, productId: string) {
    const r = (await db.execute(sql`
      select on_hand::text as on_hand, avg_cost::text as avg_cost
      from stock_balances
      where tenant_id = ${tenantA} and warehouse_id = ${warehouseId} and product_id = ${productId}
    `)) as unknown as { rows: { on_hand: string; avg_cost: string }[] };
    return r.rows[0];
  }

  async function receive(productId: string, qty: string, cost: string, lot?: { batchNo: string; expiryDate?: string | null }, wh = mainWh) {
    const { receiveStock } = await import("@/modules/inventory/stock");
    return withTenant(tenantA, (trx) =>
      receiveStock(trx, ctx(), {
        warehouseId: wh,
        productId,
        qty,
        unitCost: cost,
        lot,
        businessDate: today,
        sourceType: "test",
        sourceId: newId(),
        effectKind: `recv-${productId.slice(0, 8)}-${qty}-${cost}-${lot?.batchNo ?? ""}`,
        lineRef: skuOf(productId),
      }),
    );
  }

  const skuMap = new Map<string, string>();
  function skuOf(productId: string): string {
    return skuMap.get(productId) ?? "";
  }
  async function registerSku(productId: string, sku: string) {
    skuMap.set(productId, sku);
  }

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    ({ withTenant } = await import("@/modules/shared/db-context"));
    ({ newId } = await import("@/modules/shared/ids"));
    const t = (await db.execute(sql`select id from tenants order by created_at asc limit 1`)) as unknown as {
      rows: { id: string }[];
    };
    tenantA = t.rows[0].id;
    const u = (await db.execute(
      sql`select id from users where tenant_id = ${tenantA} order by created_at asc limit 1`,
    )) as unknown as { rows: { id: string }[] };
    actorId = u.rows[0].id;
    const w = (await db.execute(
      sql`select id from warehouses where tenant_id = ${tenantA} and code = 'MAIN'`,
    )) as unknown as { rows: { id: string }[] };
    mainWh = w.rows[0].id;
    const un = (await db.execute(
      sql`select id from units where tenant_id = ${tenantA} and code = 'EA'`,
    )) as unknown as { rows: { id: string }[] };
    unitEa = un.rows[0].id;
  });

  it("WAC: receipts update weighted average correctly (D-009)", async () => {
    const pid = await makeProduct("TEST-WAC");
    await registerSku(pid, "TEST-WAC");
    const r1 = await receive(pid, "100", "10.00");
    expect(r1.avgCost).toBe("10.0000");
    const r2 = await receive(pid, "50", "12.00");
    expect(Number(r2.onHand)).toBe(150);
    expect(Number(r2.avgCost)).toBeCloseTo(10.6667, 4);

    const { recordMovement } = await import("@/modules/inventory/stock");
    const iss = await withTenant(tenantA, (trx) =>
      recordMovement(trx, ctx(), {
        warehouseId: mainWh,
        productId: pid,
        qty: "30",
        movementType: "issue",
        businessDate: today,
        sourceType: "test",
        sourceId: newId(),
        effectKind: `iss-wac-${newId().slice(0, 8)}`,
      }),
    );
    expect(Number(iss.onHand)).toBe(120);
    expect(Math.abs(Number(iss.value))).toBeCloseTo(30 * 10.6667, 3);
  });

  it("negative stock blocked by default; zero-cost receipts blocked (D-008/D-009)", async () => {
    const pid = await makeProduct("TEST-NEG");
    await registerSku(pid, "TEST-NEG");
    const { recordMovement } = await import("@/modules/inventory/stock");
    const { isDomainError } = await import("@/modules/shared/result");

    const err = await withTenant(tenantA, (trx) =>
      recordMovement(trx, ctx(), {
        warehouseId: mainWh,
        productId: pid,
        qty: "5",
        movementType: "issue",
        businessDate: today,
        sourceType: "test",
        sourceId: newId(),
        effectKind: `iss-neg-${newId().slice(0, 8)}`,
      }),
    ).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect(err.messageKey).toBe("errors.insufficientStock");

    const zeroErr = await withTenant(tenantA, (trx) =>
      recordMovement(trx, ctx(), {
        warehouseId: mainWh,
        productId: pid,
        qty: "5",
        movementType: "receive",
        businessDate: today,
        sourceType: "test",
        sourceId: newId(),
        effectKind: `recv-zero-${newId().slice(0, 8)}`,
      }),
    ).catch((e) => e);
    expect(isDomainError(zeroErr)).toBe(true);
    expect(zeroErr.kind).toBe("ConfigurationError");
    expect(zeroErr.messageKey).toBe("errors.zeroCostBlocked");
  });

  it("concurrency: two parallel issues of the last unit — exactly one wins (INV-15)", async () => {
    const pid = await makeProduct("TEST-RACE");
    await registerSku(pid, "TEST-RACE");
    await receive(pid, "5", "10.00");
    const { recordMovement } = await import("@/modules/inventory/stock");

    const attempt = (tag: string) =>
      withTenant(tenantA, (trx) =>
        recordMovement(trx, ctx(), {
          warehouseId: mainWh,
          productId: pid,
          qty: "5",
          movementType: "issue",
          businessDate: today,
          sourceType: "test",
          sourceId: newId(),
          effectKind: `iss-race-${tag}`,
        }),
      );
    const [a, b] = await Promise.allSettled([attempt("a"), attempt("b")]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled").length;
    const rejected = [a, b].filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    const bal = await balanceOf(mainWh, pid);
    expect(Number(bal.on_hand)).toBe(0);
  });

  it("FEFO: expiry-tracked issue allocates earliest-expiry lots (D-009)", async () => {
    const pid = await makeProduct("TEST-FEFO", { trackLots: true, trackExpiry: true });
    await registerSku(pid, "TEST-FEFO");
    await receive(pid, "5", "2.00", { batchNo: "L-OLD", expiryDate: "2026-06-01" });
    await receive(pid, "5", "3.00", { batchNo: "L-NEW", expiryDate: "2026-03-01" });

    const { recordMovement } = await import("@/modules/inventory/stock");
    const iss = await withTenant(tenantA, (trx) =>
      recordMovement(trx, ctx(), {
        warehouseId: mainWh,
        productId: pid,
        qty: "6",
        movementType: "issue",
        businessDate: today,
        sourceType: "test",
        sourceId: newId(),
        effectKind: `iss-fefo-${newId().slice(0, 8)}`,
      }),
    );
    // 5 @ 3.00 (earlier expiry) + 1 @ 2.00 = 17.00
    expect(Math.abs(Number(iss.value))).toBeCloseTo(17, 4);
    expect(Number(iss.onHand)).toBe(4);

    const lots = (await db.execute(sql`
      select batch_no, qty_on_hand::text as q from stock_lots
      where tenant_id = ${tenantA} and product_id = ${pid} order by batch_no
    `)) as unknown as { rows: { batch_no: string; q: string }[] };
    expect(lots.rows.find((l) => l.batch_no === "L-NEW")?.q).toBe("0.000000");
    expect(Number(lots.rows.find((l) => l.batch_no === "L-OLD")?.q)).toBe(4);
  });

  it("ledger vs balance reconciliation holds (INV-06)", async () => {
    const { ledgerVsBalance } = await import("@/modules/inventory/stock");
    for (const sku of createdSkus) {
      const pid = await productIdBySku(sku);
      const res = await withTenant(tenantA, (trx) => ledgerVsBalance(trx, tenantA, mainWh, pid));
      expect(res.matches, sku).toBe(true);
    }
  });

  it("stock ledger is append-only at DB level (INV-05)", async () => {
    const err: unknown = await db
      .execute(sql`update stock_ledger set memo = 'x' where tenant_id = ${tenantA} limit 1`)
      .catch((x: unknown) => x);
    expect(err instanceof Error).toBe(true);
  });

  it("full transfer cycle: dispatch → partial → retry-replay → accept-all → close (INV-07)", async () => {
    const pid = await makeProduct("TEST-TRANS");
    await registerSku(pid, "TEST-TRANS");
    await receive(pid, "20", "5.00");
    await db.execute(sql`
      insert into warehouses (id, tenant_id, code, name, type)
      values (${newId()}, ${tenantA}, 'WH2', 'مستودع الاختبار الثاني', 'branch')
      on conflict (tenant_id, code) do nothing
    `);
    const wh2Row = (await db.execute(
      sql`select id from warehouses where tenant_id = ${tenantA} and code = 'WH2'`,
    )) as unknown as { rows: { id: string }[] };
    const wh2 = wh2Row.rows[0].id;
    const trRow = (await db.execute(
      sql`select id from warehouses where tenant_id = ${tenantA} and type = 'in_transit'`,
    )) as unknown as { rows: { id: string }[] };
    const inTransit = trRow.rows[0].id;

    const { createTransferDraft, dispatchTransfer, acceptTransfer, closeTransfer } = await import("@/modules/inventory/transfers");
    const { isDomainError } = await import("@/modules/shared/result");

    const tid = await withTenant(tenantA, (trx) =>
      createTransferDraft(trx, ctx(), {
        fromWarehouseId: mainWh,
        toWarehouseId: wh2,
        businessDate: today,
        lines: [{ productId: pid, qty: "12" }],
      }),
    );
    await withTenant(tenantA, (trx) => dispatchTransfer(trx, ctx(), tid));
    expect(Number((await balanceOf(mainWh, pid)).on_hand)).toBe(8);
    expect(Number((await balanceOf(inTransit, pid)).on_hand)).toBe(12);

    // partial accept 7
    const lineRow = (await db.execute(
      sql`select id from transfer_lines where transfer_id = ${tid}`,
    )) as unknown as { rows: { id: string }[] };
    const lineId = lineRow.rows[0].id;
    const r1 = await withTenant(tenantA, (trx) =>
      acceptTransfer(trx, ctx(), tid, [{ lineId, qty: "7" }], { businessDate: today, acceptRef: "r1" }),
    );
    expect(r1.status).toBe("partially_received");
    expect(Number((await balanceOf(wh2, pid)).on_hand)).toBe(7);

    // retry same accept (same acceptRef) → replay, no double receive
    await withTenant(tenantA, (trx) =>
      acceptTransfer(trx, ctx(), tid, [{ lineId, qty: "7" }], { businessDate: today, acceptRef: "r1" }),
    );
    expect(Number((await balanceOf(wh2, pid)).on_hand)).toBe(7);

    // accept remaining 5
    const r2 = await withTenant(tenantA, (trx) =>
      acceptTransfer(trx, ctx(), tid, [{ lineId, qty: "5" }], { businessDate: today, acceptRef: "r2" }),
    );
    expect(r2.status).toBe("received");
    expect(Number((await balanceOf(wh2, pid)).on_hand)).toBe(12);
    expect(Number((await balanceOf(inTransit, pid)).on_hand)).toBe(0);

    // over-receive guarded
    const over = await withTenant(tenantA, (trx) =>
      acceptTransfer(trx, ctx(), tid, [{ lineId, qty: "1" }], { businessDate: today, acceptRef: "r3" }),
    ).catch((e) => e);
    expect(isDomainError(over)).toBe(true);
    expect(["ConflictError", "ValidationError"]).toContain(over.kind);

    await withTenant(tenantA, (trx) => closeTransfer(trx, ctx(), tid));
    const closedRow = (await db.execute(
      sql`select status from transfers where id = ${tid}`,
    )) as unknown as { rows: { status: string }[] };
    expect(closedRow.rows[0].status).toBe("closed");
  });
});
