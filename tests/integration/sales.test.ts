/**
 * Sales & receivables (Phase 3): pricing/boundaries, free goods (D-021),
 * credit limits, idempotent posting (INV-02), receipts/allocations (INV-08/09),
 * returns, e-payment settlement state, GL↔AR reconciliation (RL-2).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;
const RUN = Math.random().toString(36).slice(2, 8);
const TODAY = "2026-04-10";

describe.skipIf(!DB)("sales — invoices, pricing, allocations, returns", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  let tenantA = "";
  let actorId = "";
  let mainWh = "";
  let unitEa = "";
  let customerId = "";
  let holdCustomerId = "";
  let cashTreasury = "";
  let productId = "";
  let lotProductId = "";
  const ctx = () => ({ tenantId: tenantA, actorId });

  async function scalar(q: ReturnType<typeof sql>): Promise<string> {
    const r = (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
    return Object.values(r.rows[0])[0] as string;
  }

  async function balance(product: string): Promise<string> {
    return scalar(sql`
      select coalesce(on_hand, 0)::text from stock_balances
      where tenant_id = ${tenantA} and warehouse_id = ${mainWh} and product_id = ${product}
    `);
  }

  async function glAccountBalance(code: string): Promise<number> {
    const v = await scalar(sql`
      select coalesce(sum(l.debit::numeric - l.credit::numeric), 0)::text
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      where l.tenant_id = ${tenantA} and a.code = ${code} and e.status = 'posted'
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
    unitEa = await scalar(sql`select id from units where tenant_id = ${tenantA} and code = 'EA'`);
    cashTreasury = await scalar(sql`select id from treasury_accounts where tenant_id = ${tenantA} and code = 'CASH-MAIN'`);

    // per-run product + stock (200 @ 5.00)
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, track_lots, track_expiry, tax_category, sale_price, min_price, max_price)
      values (${newId()}, ${tenantA}, ${"P3-" + RUN}, 'منتج المرحلة ٣', ${unitEa}, false, false, 'standard', '10.00', '8.00', '12.00')
    `);
    productId = await scalar(sql`select id from products where tenant_id = ${tenantA} and sku = ${"P3-" + RUN}`);
    const { receiveStock } = await import("@/modules/inventory/stock");
    await withTenant(tenantA, (trx) =>
      receiveStock(trx, ctx(), {
        warehouseId: mainWh, productId, qty: "200", unitCost: "5.00",
        businessDate: TODAY, sourceType: "test", sourceId: newId(), effectKind: `recv-${RUN}`, lineRef: RUN,
      }),
    );

    // lot-tracked product for free-goods cost test (100 @ 7.50)
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, track_lots, track_expiry, tax_category, sale_price)
      values (${newId()}, ${tenantA}, ${"P3L-" + RUN}, 'منتج تشغيلات', ${unitEa}, true, false, 'standard', '15.00')
    `);
    lotProductId = await scalar(sql`select id from products where tenant_id = ${tenantA} and sku = ${"P3L-" + RUN}`);
    await withTenant(tenantA, (trx) =>
      receiveStock(trx, ctx(), {
        warehouseId: mainWh, productId: lotProductId, qty: "100", unitCost: "7.50",
        lot: { batchNo: `B-${RUN}`, expiryDate: null },
        businessDate: TODAY, sourceType: "test", sourceId: newId(), effectKind: `recvL-${RUN}`, lineRef: RUN,
      }),
    );

    // per-run customer (limit 1000) + hold customer
    for (const [code, hold] of [["C3-" + RUN, false], ["C3H-" + RUN, true]] as const) {
      await db.execute(sql`
        insert into customers (id, tenant_id, code, name_ar, credit_limit, payment_terms_days, credit_hold)
        values (${newId()}, ${tenantA}, ${code}, 'عميل اختبار', '1000', 30, ${hold})
      `);
    }
    customerId = await scalar(sql`select id from customers where tenant_id = ${tenantA} and code = ${"C3-" + RUN}`);
    holdCustomerId = await scalar(sql`select id from customers where tenant_id = ${tenantA} and code = ${"C3H-" + RUN}`);
  });

  it("cash invoice (walk-in): VAT math, stock out, balanced GL, number assigned", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const r = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId: null,
        warehouseId: mainWh,
        businessDate: TODAY,
        isCredit: false,
        lines: [{ productId, qtyBase: "10" }], // 10 × 10 = 100 + 15% = 115
        paymentLines: [{ method: "cash", amount: "115.00", treasuryAccountId: cashTreasury }],
      }, false),
    );
    expect(r.invoiceNo).toBeTypeOf("number");
    const inv = await scalar(sql`select total::text from sales_invoices where id = ${r.invoiceId}`);
    expect(Number(inv)).toBeCloseTo(115, 2);
    expect(Number(await balance(productId))).toBeCloseTo(190, 4);

    const drCr = await scalar(sql`
      select (sum(l.debit::numeric) - sum(l.credit::numeric))::text
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.source_type = 'sales_invoice' and e.source_id = ${r.invoiceId}
    `);
    expect(Number(drCr)).toBeCloseTo(0, 4);
  });

  it("customer price + boundaries: custom price wins; below-min without permission blocked; override recorded", async () => {
    const { computeSalesLines } = await import("@/modules/sales/invoices");
    const { isDomainError } = await import("@/modules/shared/result");
    await db.execute(sql`
      insert into customer_prices (id, tenant_id, customer_id, product_id, price, effective_from)
      values (${newId()}, ${tenantA}, ${customerId}, ${productId}, '9.00', '2026-01-01')
      on conflict do nothing
    `);
    await withTenant(tenantA, async (trx) => {
      const lines = await computeSalesLines(trx, tenantA, [{ productId, qtyBase: "1" }], {
        customerId, date: TODAY, canPriceOverride: false,
      });
      expect(lines[0].unitPrice.toFixed(2)).toBe("9.00");

      const blocked = await computeSalesLines(trx, tenantA,
        [{ productId, qtyBase: "1", unitPrice: "7.00" }],
        { customerId, date: TODAY, canPriceOverride: false },
      ).catch((e) => e);
      expect(isDomainError(blocked)).toBe(true);
      expect(blocked.messageKey).toBe("errors.priceOutOfBounds");

      const overridden = await computeSalesLines(trx, tenantA,
        [{ productId, qtyBase: "1", unitPrice: "7.00", overrideReason: "تصفية" }],
        { customerId, date: TODAY, canPriceOverride: true },
      );
      expect(overridden[0].unitPrice.toFixed(2)).toBe("7.00");
      expect(overridden[0].originalPrice?.toFixed(2)).toBe("9.00");
    });
  });

  it("free goods: zero revenue, stock out at cost, expense account debited (D-021)", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const r = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId,
        warehouseId: mainWh,
        businessDate: TODAY,
        isCredit: false,
        lines: [
          { productId, qtyBase: "1" },                       // customer price 9.00 + 1.35 vat
          { productId: lotProductId, qtyBase: "2", lineKind: "free" }, // cost 2×7.50 = 15
        ],
        paymentLines: [{ method: "cash", amount: "10.35", treasuryAccountId: cashTreasury }],
      }, false),
    );
    const inv = await scalar(sql`select total::text from sales_invoices where id = ${r.invoiceId}`);
    expect(Number(inv)).toBeCloseTo(10.35, 2);
    expect(Number(await balance(lotProductId))).toBeCloseTo(98, 4);
    const freeAcct = await scalar(sql`select id from accounts where tenant_id = ${tenantA} and code = '5102'`);
    const dr = await scalar(sql`
      select sum(l.debit::numeric)::text from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where e.source_type = 'sales_invoice' and e.source_id = ${r.invoiceId} and l.account_id = ${freeAcct}
    `);
    expect(Number(dr)).toBeCloseTo(15, 2);
  });

  it("credit rules: limit breach blocked; hold customer blocked; due date auto-set from terms", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const { isDomainError } = await import("@/modules/shared/result");

    // 100 units × 10 = 1000 + 150 = 1150 total > limit 1000
    const tooBig = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId, qtyBase: "100" }],
      }, false),
    ).catch((e) => e);
    expect(isDomainError(tooBig)).toBe(true);
    expect(tooBig.messageKey).toBe("errors.creditLimitExceeded");

    const hold = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId: holdCustomerId, warehouseId: mainWh, businessDate: TODAY, isCredit: false,
        lines: [{ productId, qtyBase: "1" }],
        paymentLines: [{ method: "cash", amount: "11.50", treasuryAccountId: cashTreasury }],
      }, false),
    ).catch((e) => e);
    expect(isDomainError(hold)).toBe(true);
    expect(hold.messageKey).toBe("errors.customerOnHold");

    const okInv = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId, qtyBase: "5" }], // 50 + 7.5 = 57.5
      }, false),
    );
    const due = await scalar(sql`select due_date from sales_invoices where id = ${okInv.invoiceId}`);
    expect(due).toBe("2026-05-10");
  });

  it("posting is idempotent (clientOpId): double submit → one invoice, one journal (INV-02)", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const opId = newId() as string;
    const input = {
      customerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
      clientOpId: opId,
      lines: [{ productId, qtyBase: "2" }],
    };
    const [r1, r2] = await Promise.all([
      withTenant(tenantA, (trx) => createAndPostInvoice(trx, ctx(), input, false)),
      withTenant(tenantA, (trx) => createAndPostInvoice(trx, ctx(), input, false)),
    ]);
    expect(r1.invoiceId).toBe(r2.invoiceId);
    expect(r1.invoiceNo).toBe(r2.invoiceNo);
    const cnt = await scalar(sql`select count(*)::text from sales_invoices where client_op_id = ${opId}`);
    expect(Number(cnt)).toBe(1);
    const jcnt = await scalar(sql`
      select count(*)::text from journal_entries where source_type = 'sales_invoice' and source_id = ${r1.invoiceId}
    `);
    expect(Number(jcnt)).toBe(1);
  });

  it("receipts & allocations (INV-09): outstanding guard, advance, advance application", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const { createReceiptCore, applyAdvance } = await import("@/modules/sales/receipts");
    const { invoiceOutstanding, advanceBalance } = await import("@/modules/sales/balances");
    const { isDomainError } = await import("@/modules/shared/result");

    const inv = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId, qtyBase: "3" }], // 30 + 4.5 = 34.5
      }, false),
    );

    await withTenant(tenantA, async (trx) => {
      const excess = await createReceiptCore(trx, ctx(), {
        customerId, businessDate: TODAY,
        paymentLines: [{ method: "cash", amount: "40", treasuryAccountId: cashTreasury }],
        allocations: [{ invoiceId: inv.invoiceId, amount: "40" }],
        memo: null,
      }).catch((e) => e);
      expect(isDomainError(excess)).toBe(true);
      expect(excess.messageKey).toBe("errors.allocExceedsOutstanding");

      await createReceiptCore(trx, ctx(), {
        customerId, businessDate: TODAY,
        paymentLines: [{ method: "cash", amount: "25.00", treasuryAccountId: cashTreasury }],
        allocations: [{ invoiceId: inv.invoiceId, amount: "20.00" }],
        memo: null,
      });
      expect((await invoiceOutstanding(trx, tenantA, inv.invoiceId)).toFixed(2)).toBe("11.05");
      expect((await advanceBalance(trx, tenantA, customerId)).toFixed(2)).toBe("5.00");

      await applyAdvance(trx, ctx(), { customerId, invoiceId: inv.invoiceId, amount: "5.00", businessDate: TODAY });
      expect((await invoiceOutstanding(trx, tenantA, inv.invoiceId)).toFixed(2)).toBe("6.05");
      expect((await advanceBalance(trx, tenantA, customerId)).toFixed(2)).toBe("0.00");

      const noAdvance = await applyAdvance(trx, ctx(), {
        customerId, invoiceId: inv.invoiceId, amount: "1.00", businessDate: TODAY,
      }).catch((e) => e);
      expect(isDomainError(noAdvance)).toBe(true);
      expect(noAdvance.messageKey).toBe("errors.advanceInsufficient");
    });
  });

  it("returns: qty caps, stock back at original COGS, credit-note GL (P-05)", async () => {
    const { createAndPostInvoice, createReturn } = await import("@/modules/sales/invoices");
    const { isDomainError } = await import("@/modules/shared/result");

    const inv = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId, qtyBase: "10" }], // 100 + 15 = 115
      }, false),
    );
    const before = Number(await balance(productId));
    const lineId = (await scalar(sql`select id from sales_invoice_lines where invoice_id = ${inv.invoiceId} limit 1`)) as string;

    const ret = await withTenant(tenantA, (trx) =>
      createReturn(trx, ctx(), inv.invoiceId, { [lineId]: "4" }, TODAY),
    );
    expect(Number(await balance(productId))).toBeCloseTo(before + 4, 4);
    const retTotal = await scalar(sql`select total::text from sales_invoices where id = ${ret.invoiceId}`);
    expect(Number(retTotal)).toBeCloseTo(41.4, 2); // 36 + 5.4 vat (customer price 9)

    const gl = await scalar(sql`
      select (sum(case when l.debit::numeric > 0 then l.debit::numeric else -l.credit::numeric end))::text
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.source_type = 'sales_return' and e.source_id = ${ret.invoiceId}
    `);
    expect(Number(gl)).toBeCloseTo(0, 4);

    const tooMuch = await withTenant(tenantA, (trx) =>
      createReturn(trx, ctx(), inv.invoiceId, { [lineId]: "7" }, TODAY),
    ).catch((e) => e);
    expect(isDomainError(tooMuch)).toBe(true);
    expect(tooMuch.messageKey).toBe("errors.returnExceedsSold");
  });

  it("drafts: no GL/stock effects; later post works exactly once (INV-11)", async () => {
    const { createInvoiceDraft, postInvoice } = await import("@/modules/sales/invoices");
    // scope the count to this file's posting date so parallel suites can't skew it
    const glCountBefore = await scalar(
      sql`select count(*)::text from journal_entries where tenant_id = ${tenantA} and business_date = ${TODAY}`,
    );
    const draftId = await withTenant(tenantA, (trx) =>
      createInvoiceDraft(trx, ctx(), {
        customerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId, qtyBase: "1" }],
      }, false),
    );
    const glCountAfterDraft = await scalar(
      sql`select count(*)::text from journal_entries where tenant_id = ${tenantA} and business_date = ${TODAY}`,
    );
    expect(glCountAfterDraft).toBe(glCountBefore);

    const [p1, p2] = await Promise.all([
      withTenant(tenantA, (trx) => postInvoice(trx, ctx(), draftId, {})),
      withTenant(tenantA, (trx) => postInvoice(trx, ctx(), draftId, {})),
    ]);
    expect(p1.invoiceNo).toBe(p2.invoiceNo);
    const status = await scalar(sql`select business_status from sales_invoices where id = ${draftId}`);
    expect(status).toBe("posted");
  });

  it("card payment tracked as pending settlement, not settled cash (FR-031)", async () => {
    const { createReceiptCore, settleReceiptLine } = await import("@/modules/sales/receipts");
    const inv = await withTenant(tenantA, async (trx) => {
      const { createAndPostInvoice } = await import("@/modules/sales/invoices");
      return createAndPostInvoice(trx, ctx(), {
        customerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId, qtyBase: "1" }],
      }, false);
    });
    await withTenant(tenantA, async (trx) => {
      await createReceiptCore(trx, ctx(), {
        customerId, businessDate: TODAY,
        paymentLines: [{ method: "card", amount: "10.35", reference: "POS-99" }],
        allocations: [{ invoiceId: inv.invoiceId, amount: "10.35" }],
        memo: null,
      });
    });
    const line = await scalar(sql`
      select rl.id from receipt_lines rl join receipts r on r.id = rl.receipt_id
      where r.customer_id = ${customerId} and rl.method = 'card' order by r.created_at desc limit 1
    `);
    const st = await scalar(sql`select settlement_status from receipt_lines where id = ${line}`);
    expect(st).toBe("pending");
    await withTenant(tenantA, async (trx) => settleReceiptLine(trx, ctx(), line));
    const settled = await scalar(sql`select settlement_status from receipt_lines where id = ${line}`);
    expect(settled).toBe("settled");
  });

  it("posted sales invoice is immutable at DB level (INV-03)", async () => {
    const inv: string = await scalar(sql`
      select id from sales_invoices where tenant_id = ${tenantA} and business_status='posted' order by created_at desc limit 1
    `);
    const err: unknown = await db
      .execute(sql`update sales_invoices set total = total + 1 where id = ${inv}`)
      .catch((x: unknown) => x);
    expect(err instanceof Error).toBe(true);
    const err2: unknown = await db
      .execute(sql`delete from sales_invoices where id = ${inv}`)
      .catch((x: unknown) => x);
    expect(err2 instanceof Error).toBe(true);
  });

  it("purchase cycle: stock in at cost, AP, payment allocation, supplier exposure", async () => {
    const { createPurchaseDraft, postPurchaseInvoice, createSupplierPayment, purchaseOutstanding, supplierExposure } =
      await import("@/modules/purchasing/purchases");
    await db.execute(sql`
      insert into suppliers (id, tenant_id, code, name_ar, payment_terms_days)
      values (${newId()}, ${tenantA}, ${"SUP3-" + RUN}, 'مورد المرحلة ٣', 30)
    `);
    const supId = await scalar(sql`select id from suppliers where tenant_id = ${tenantA} and code = ${"SUP3-" + RUN}`);
    const before = Number(await balance(productId));

    const invId = await withTenant(tenantA, (trx) =>
      createPurchaseDraft(trx, ctx(), {
        supplierId: supId, supplierRef: "SUP-INV-1", warehouseId: mainWh, businessDate: TODAY,
        lines: [{ productId, qtyBase: "20", unitCost: "6.00" }], // 120 + 18 vat = 138
      }),
    );
    const posted = await withTenant(tenantA, (trx) => postPurchaseInvoice(trx, ctx(), invId));
    expect(posted.invoiceNo).toBeTypeOf("number");
    expect(Number(await balance(productId))).toBeCloseTo(before + 20, 4);

    await withTenant(tenantA, async (trx) => {
      expect((await supplierExposure(trx, tenantA, supId)).toFixed(2)).toBe("138.00");
      await createSupplierPayment(trx, ctx(), {
        supplierId: supId, businessDate: TODAY, method: "cash", treasuryAccountId: cashTreasury,
        amount: "50.00", allocations: [{ purchaseInvoiceId: invId, amount: "50.00" }], memo: null,
      });
      expect((await purchaseOutstanding(trx, tenantA, invId)).toFixed(2)).toBe("88.00");
    });

    const err: unknown = await db
      .execute(sql`update purchase_invoices set supplier_ref = 'x' where id = ${invId}`)
      .catch((x: unknown) => x);
    expect(err instanceof Error).toBe(true);
  });

  it("RL-2: AR control account == Σ customer exposures (INV-08 reconciliation)", async () => {
    const { customerExposure } = await import("@/modules/sales/balances");
    const customersRows = (await db.execute(
      sql`select id from customers where tenant_id = ${tenantA}`,
    )) as unknown as { rows: { id: string }[] };
    let total = 0;
    await withTenant(tenantA, async (trx) => {
      for (const c of customersRows.rows) {
        total += Number((await customerExposure(trx, tenantA, c.id)).toFixed(2));
      }
    });
    const ar = await glAccountBalance("1103");
    expect(ar).toBeCloseTo(total, 2);
  });
});
