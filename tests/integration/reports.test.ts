/**
 * Phase 7 acceptance — reporting & reconciliation (REPORTING_SPECIFICATION,
 * AC-031, RL-1…RL-5).
 *
 * The fixture is deliberately messy ("chaos"): cash + credit sales, a free-goods
 * line, a return (credit note), a partially allocated receipt, a purchase with
 * input VAT, a supplier payment, a manual journal entry plus its reversal, and a
 * draft that must never be counted. Every figure the reports show is then checked
 * against an INDEPENDENT representation of the same fact:
 *
 *   documents  ↔ ledger      (revenue, VAT, inventory value, AR/AP)
 *   subledger  ↔ control     (RL-2)          stock ledger ↔ inventory control (RL-3)
 *   trial balance footer     (RL-1)          VAT report ↔ GL VAT accounts (RL-5)
 *
 * Reversals are posted entries, so "no double counting" is asserted by requiring
 * the reversed document to net to zero in both the ledger and the reports.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;
const RUN = Math.random().toString(36).slice(2, 8);
const VAT = "311122393500003";
const DAY = (n: number, base = "2026-06-10") => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TODAY = DAY(0);

describe.skipIf(!DB)("reports — Phase 7 reconciliation chaos fixture", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  let tenant = "";
  let actorId: string | null = null;
  let warehouseId = "";
  let supplierId = "";
  let vatCustomerId = "";
  let unitEa = "";
  let accounts: Record<string, string> = {};
  const products: Record<string, string> = {};
  const creditInvoice = { id: "", total: 0 };
  const cashInvoice = { id: "", lineId: "", net: 0 };
  const returnDoc = { id: "", net: 0 };
  let draftInvoiceId = "";
  const manual = { original: "", reversal: "" };

  const ctx = () => ({ tenantId: tenant, actorId });

  async function scalar(q: ReturnType<typeof sql>): Promise<string | null> {
    const r = (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
    const row = r.rows[0];
    return row ? (Object.values(row)[0] as string | null) : null;
  }

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    ({ withTenant } = await import("@/modules/shared/db-context"));
    ({ newId } = await import("@/modules/shared/ids"));

    tenant = newId();
    await db.execute(sql`
      insert into tenants (id, name, name_en, status, plan)
      values (${tenant}, ${`منشأة التقارير ${RUN}`}, ${`reports ${RUN}`}, 'active', 'test')
    `);
    await db.execute(sql`
      insert into companies (tenant_id, legal_name, legal_name_en, vat_number, cr_number, base_currency, timezone, locale)
      values (${tenant}, 'شركة التقارير التجريبية', 'Reporting Test Co', ${VAT}, '1010000000', 'SAR', 'Asia/Riyadh', 'ar')
    `);
    const branchId = newId();
    await db.execute(sql`
      insert into branches (id, tenant_id, code, name, is_default)
      values (${branchId}, ${tenant}, 'MAIN', 'الفرع الرئيسي', true)
    `);
    warehouseId = newId();
    await db.execute(sql`
      insert into warehouses (id, tenant_id, branch_id, code, name)
      values (${warehouseId}, ${tenant}, ${branchId}, 'MAIN', 'المستودع الرئيسي')
    `);
    const u = await db.execute(sql`
      insert into users (id, tenant_id, email, password_hash, name)
      values (${newId()}, ${tenant}, ${`reports-${RUN}@test`}, 'x', 'محاسب التقارير')
      returning id
    `);
    actorId = ((u as unknown as { rows: { id: string }[] }).rows[0]?.id ?? null) as string;
    const unit = await db.execute(sql`
      insert into units (id, tenant_id, code, name_ar)
      values (${newId()}, ${tenant}, 'EA', 'حبة') returning id
    `);
    unitEa = (unit as unknown as { rows: { id: string }[] }).rows[0].id;

    // COA + mappings (report figures must come from configured control accounts)
    await withTenant(tenant, async (trx) => {
      const { ensureFiscalYear } = await import("@/modules/accounting/periods");
      await ensureFiscalYear(trx, tenant, 2026);
      const { ensureMappings, ensureCoa } = await import("@/modules/accounting/coa");
      await ensureMappings(trx, tenant);
      const byCode = await ensureCoa(trx, tenant);
      accounts = Object.fromEntries(byCode.entries());
    });

    // catalog: standard / zero-rated / exempt / second standard (free goods)
    const defs = [
      ["P15", "صنف خاضع", "standard", "100.00"],
      ["PZ", "صنف صفري التصدير", "zero", "50.00"],
      ["PE", "صنف معفى تأمين", "exempt", "80.00"],
      ["PF", "صنف هدية", "standard", "40.00"],
    ] as const;
    for (const [sku, name, category, price] of defs) {
      const id = newId();
      products[sku] = id;
      await db.execute(sql`
        insert into products (id, tenant_id, sku, name_ar, stock_unit_id, tax_category, sale_price, min_price, max_price)
        values (${id}, ${tenant}, ${sku}, ${name}, ${unitEa}, ${category}, ${price}, '1.00', '500.00')
      `);
    }

    // buyer: VAT-registered with the complete address BR-KSA-63 requires
    vatCustomerId = newId();
    await db.execute(sql`
      insert into customers (id, tenant_id, code, name_ar, tax_number, credit_limit, payment_terms_days,
                             address, building_no, plot_identification, district, city, postal_code, cr_number)
      values (${vatCustomerId}, ${tenant}, 'C1', 'شركة العميل', '311122393500003', '100000', 30,
              'طريق الملك فهد', '1111', '2222', 'العليا', 'الرياض', '12211', '1010112233')
    `);
    const sup = await db.execute(sql`
      insert into suppliers (id, tenant_id, code, name_ar)
      values (${newId()}, ${tenant}, 'S1', 'مورد الأغذية') returning id
    `);
    supplierId = (sup as unknown as { rows: { id: string }[] }).rows[0].id;

    // tax enabled with the tenant rulings for zero-rated and exempt supplies
    await db.execute(sql`
      insert into tax_configs (tenant_id, enabled, env, street, district, city, postal_code, building_no,
                               plot_identification, industry, exemption_reasons)
      values (${tenant}, true, 'developer-portal', 'طريق الملك فهد', 'العليا', 'الرياض', '12345', '2322', '2223',
              'أغذية', ${JSON.stringify({ zero: "VATEX-SA-32", exempt: "VATEX-SA-29-7" })}::jsonb)
    `);

    /* ------------------------------------------------------------------ chaos */
    const { createPurchaseDraft, postPurchaseInvoice, createSupplierPayment } = await import(
      "@/modules/purchasing/purchases"
    );
    const { createAndPostInvoice, createReturn, createInvoiceDraft } = await import("@/modules/sales/invoices");
    const { createReceiptCore } = await import("@/modules/sales/receipts");

    // 1. purchase: 40 P15 @ 60, 20 PZ @ 30, 20 PE @ 50, 20 PF @ 20 (all + 15% VAT)
    const purchaseId = await withTenant(tenant, (trx) =>
      createPurchaseDraft(
        trx,
        ctx(),
        {
          supplierId,
          warehouseId,
          businessDate: DAY(-5),
          dueDate: DAY(25),
          lines: [
            { productId: products.P15, qtyBase: "40", unitCost: "60.00" },
            { productId: products.PZ, qtyBase: "20", unitCost: "30.00" },
            { productId: products.PE, qtyBase: "20", unitCost: "50.00" },
            { productId: products.PF, qtyBase: "20", unitCost: "20.00" },
          ],
        },
      ),
    );
    await withTenant(tenant, (trx) => postPurchaseInvoice(trx, ctx(), purchaseId));

    // 2. cash sale (walk-in, simplified): 2 P15 with a 20.00 discount
    const cash = await withTenant(tenant, (trx) =>
      createAndPostInvoice(
        trx,
        ctx(),
        {
          customerId: null,
          warehouseId,
          businessDate: DAY(-2),
          isCredit: false,
          lines: [{ productId: products.P15, qtyBase: "2", discountAmount: "20.00" }],
          paymentLines: [{ method: "cash", amount: "207.00" }],
        },
        false,
      ),
    );
    cashInvoice.id = cash.invoiceId;

    // 3. credit sale of the zero-rated + exempt products to the VAT buyer
    const credit = await withTenant(tenant, (trx) =>
      createAndPostInvoice(
        trx,
        ctx(),
        {
          customerId: vatCustomerId,
          warehouseId,
          businessDate: DAY(-1),
          isCredit: true,
          dueDate: DAY(29),
          lines: [
            { productId: products.PZ, qtyBase: "2" },
            { productId: products.PE, qtyBase: "1" },
          ],
        },
        false,
      ),
    );
    creditInvoice.id = credit.invoiceId;
    creditInvoice.total = Number(
      await scalar(sql`select total::text from sales_invoices where id = ${credit.invoiceId}`),
    );

    // 4. free-goods line on a paid sale (revenue 0, cost expensed — D-021)
    await withTenant(tenant, (trx) =>
      createAndPostInvoice(
        trx,
        ctx(),
        {
          customerId: null,
          warehouseId,
          businessDate: DAY(-1),
          isCredit: false,
          lines: [
            { productId: products.PF, qtyBase: "1", lineKind: "free" },
            { productId: products.P15, qtyBase: "1" },
          ],
          paymentLines: [{ method: "cash", amount: "115.00" }],
        },
        false,
      ),
    );

    // 5. return of one P15 line from the cash sale
    const cashLines = (await db.execute(sql`
      select id from sales_invoice_lines where invoice_id = ${cash.invoiceId} order by line_no limit 1
    `)) as unknown as { rows: { id: string }[] };
    cashInvoice.lineId = cashLines.rows[0].id;
    const ret = await withTenant(tenant, (trx) =>
      createReturn(trx, ctx(), cashInvoice.id, { [cashInvoice.lineId]: "1" }, DAY(0)),
    );
    returnDoc.id = ret.invoiceId;
    returnDoc.net = Number(await scalar(sql`select subtotal::text from sales_invoices where id = ${ret.invoiceId}`));

    // 6. partial receipt against the credit invoice
    await withTenant(tenant, (trx) =>
      createReceiptCore(trx, ctx(), {
        customerId: vatCustomerId,
        businessDate: DAY(0),
        paymentLines: [{ method: "cash", amount: "50.00" }],
        allocations: [{ invoiceId: creditInvoice.id, amount: "50.00" }],
      }),
    );

    // 7. supplier payment (partial) from a bank treasury account
    const treasuryId = newId();
    await db.execute(sql`
      insert into treasury_accounts (id, tenant_id, code, name, kind)
      values (${treasuryId}, ${tenant}, 'BNK-1', 'حساب البنك', 'bank')
    `);
    await withTenant(tenant, (trx) =>
      createSupplierPayment(trx, ctx(), {
        supplierId,
        businessDate: DAY(0),
        method: "bank_transfer",
        treasuryAccountId: treasuryId,
        amount: "200.00",
        allocations: [{ purchaseInvoiceId: purchaseId, amount: "200.00" }],
      }),
    );

    // 8. a manual entry + its reversal: both posted, net effect must be zero
    const { postEntry, reverseEntry } = await import("@/modules/accounting/posting");
    manual.original = await withTenant(tenant, async (trx) => {
      const entry = await postEntry(trx, ctx(), {
        sourceType: "manual",
        sourceId: newId(),
        businessDate: DAY(0),
        memo: "مصروف إداري مرحّل ثم معكوس",
        lines: [
          { accountId: accounts["5106"], debit: "300.00", credit: "0" },
          { accountId: accounts["1101"], debit: "0", credit: "300.00" },
        ],
      });
      return entry.id;
    });
    manual.reversal = await withTenant(tenant, async (trx) => {
      const entry = await reverseEntry(trx, ctx(), manual.original, DAY(0), "عكس مصروف إداري");
      return entry.id;
    });

    // 9. a draft that must never be counted anywhere
    draftInvoiceId = await withTenant(tenant, (trx) =>
      createInvoiceDraft(
        trx,
        ctx(),
        {
          customerId: vatCustomerId,
          warehouseId,
          businessDate: DAY(0),
          isCredit: true,
          lines: [{ productId: products.P15, qtyBase: "5" }],
        },
        false,
      ),
    );
  });

  afterAll(async () => {
    await db.execute(sql`update tax_configs set enabled = false where tenant_id = ${tenant}`);
  });

  it("RL-1: the trial balance footer balances and ties to the raw ledger", async () => {
    const ledger = await import("@/modules/reports/ledger");
    const tb = await withTenant(tenant, (trx) => ledger.trialBalance(trx, tenant, {}));
    expect(tb.totals.balanced).toBe(true);
    expect(tb.totals.debit).toBe(tb.totals.credit);

    const raw = (await db.execute(sql`
      select coalesce(sum(l.debit), 0)::text as debit, coalesce(sum(l.credit), 0)::text as credit
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.tenant_id = ${tenant} and e.status = 'posted'
    `)) as unknown as { rows: { debit: string; credit: string }[] };
    expect(tb.totals.debit).toBeCloseTo(Number(raw.rows[0].debit), 2);
    expect(tb.totals.credit).toBeCloseTo(Number(raw.rows[0].credit), 2);

    // drafts are excluded: the draft invoice has no journal entry at all
    const draftEntries = await scalar(sql`
      select count(*)::text from journal_entries where tenant_id = ${tenant} and source_id = ${draftInvoiceId}
    `);
    expect(Number(draftEntries)).toBe(0);

    // an empty range yields an empty, still-balanced balance
    const empty = await withTenant(tenant, (trx) =>
      ledger.trialBalance(trx, tenant, { from: "2020-01-01", to: "2020-12-31" }),
    );
    expect(empty.rows).toHaveLength(0);
    expect(empty.totals.debit).toBe(0);
  });

  it("documents reconcile with the ledger: revenue, VAT and inventory (no double counting)", async () => {
    const sales = await import("@/modules/reports/sales");
    const ledger = await import("@/modules/reports/ledger");
    const tax = await import("@/modules/reports/tax");

    const byDimension = await withTenant(tenant, (trx) => sales.salesByDimension(trx, tenant, {}, "product"));
    const types = await withTenant(tenant, (trx) => ledger.balancesByType(trx, tenant, {}));
    const totals = (await db.execute(sql`
      select coalesce(sum(case when invoice_type = 'sale_return' then 0 else subtotal end), 0)::text as sales_net,
             coalesce(sum(case when invoice_type = 'sale_return' then subtotal else 0 end), 0)::text as returns_net,
             coalesce(sum(discount_total), 0)::text as discounts
      from sales_invoices where tenant_id = ${tenant} and business_status = 'posted'
    `)) as unknown as { rows: { sales_net: string; returns_net: string; discounts: string }[] };
    const salesNet = Number(totals.rows[0].sales_net);
    const returnsNet = Number(totals.rows[0].returns_net);
    const discounts = Number(totals.rows[0].discounts);

    // documents: 180 (cash sale: 200 list, 20 discount) + 180 (zero-rated and exempt
    // credit sale) + 100 (paid sale carrying the free line); the return of one P15
    // unit is its own document, dated today
    expect(salesNet).toBeCloseTo(180 + 180 + 100, 2);
    expect(returnsNet).toBeCloseTo(90, 2);
    expect(discounts).toBeCloseTo(20, 2);

    // the report signs the credit note negative, so its own total IS net revenue
    expect(byDimension.totals.net).toBeCloseTo(salesNet - returnsNet, 2);

    // here is the ledger identity: revenue is posted GROSS with discounts in their own
    // contra account (4103) and returns in a contra account (4102), so
    //   ledger revenue = gross − discounts − returns = salesNet − returnsNet
    // (documents carry the net, the ledger carries gross + contra accounts — two
    // representations of one fact, and they agree exactly)
    expect(types.revenue).toBeCloseTo(salesNet - returnsNet, 2);

    // VAT: documents vs the output VAT control account (RL-5 input half)
    const vat = await withTenant(tenant, (trx) => tax.vatReconciliation(trx, tenant, {}));
    const lineVat = await withTenant(tenant, (trx) => tax.invoiceVatFromLines(trx, tenant, {}));
    expect(vat.outputVat).toBeCloseTo(lineVat, 2);
    expect(vat.outputVat).toBeCloseTo(27 + 15 - 13.5, 2);

    // free goods never appear as revenue but their cost is expensed (two representations
    // of the same fact: 0 revenue in the report, 20.00 on the free-goods expense account)
    expect(byDimension.totals.freeQty).toBe(1);
    expect(byDimension.totals.freeCost).toBeCloseTo(20, 2);
    const freeExpense = await scalar(sql`
      select coalesce(sum(l.debit), 0)::text from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.tenant_id = ${tenant} and a.code = '5102'
    `);
    expect(Number(freeExpense)).toBeCloseTo(20, 2);

    // the returns/discounts report reads the same documents (gross = net + discounts)
    const rd = await withTenant(tenant, (trx) => sales.returnsAndDiscounts(trx, tenant, {}));
    expect(rd.gross).toBeCloseTo(salesNet + discounts, 2);
    expect(rd.discounts).toBeCloseTo(discounts, 2);
    expect(rd.returnsNet).toBeCloseTo(returnsNet, 2);

    // draft invoice excluded from the report as well
    const withDraft = await withTenant(tenant, (trx) => sales.salesByDimension(trx, tenant, {}, "customer"));
    expect(withDraft.totals.net).toBeCloseTo(salesNet - returnsNet, 2);
  });

  it("RL-2: AR/AP subledger equals the control accounts, with aging buckets", async () => {
    const reconcile = await import("@/modules/reports/reconcile");
    const { arAging, apAging } = await import("@/modules/reports/receivables");

    const [ar, ap] = await withTenant(tenant, (trx) =>
      Promise.all([arAging(trx, tenant, { asOf: TODAY }), apAging(trx, tenant, { asOf: TODAY })]),
    );

    // AR carries exactly what the ledger carries: the credit invoice (180) minus the
    // 50.00 receipt minus the credit note (103.50) = 26.50
    expect(ar.totalOutstanding).toBeCloseTo(180 - 50 - 103.5, 2);
    // both documents are current (due in 29 days / no due date); the receipt already
    // reduced the invoice, so the bucket shows the same net figure as the total
    expect(ar.buckets.current).toBeCloseTo(180 - 50 - 103.5, 2);
    expect(ar.buckets.total).toBeCloseTo(26.5, 2);
    expect(ar.rows.find((r) => r.partyId === "walk-in")?.total).toBeCloseTo(-103.5, 2);

    const results = await withTenant(tenant, (trx) => reconcile.rl2SubledgerVsControl(trx, tenant, {}, TODAY));
    for (const result of results) {
      expect({ code: result.code, title: result.titleKey, ok: result.ok, difference: result.difference }).toEqual({
        code: "RL-2",
        title: result.titleKey,
        ok: true,
        difference: 0,
      });
    }
    expect(results).toHaveLength(2);
    // AP: purchase 4400 net + 420 VAT (only the standard-rated lines carry VAT) = 4820,
    // minus the 200.00 payment
    expect(ap.totalPayable).toBeCloseTo(4820 - 200, 2);
  });

  it("RL-3: stock valuation equals the inventory control account", async () => {
    const inventory = await import("@/modules/reports/inventory");
    const reconcile = await import("@/modules/reports/reconcile");

    const valuation = await withTenant(tenant, (trx) => inventory.stockValuation(trx, tenant, {}));
    // purchases 4600 − COGS of everything sold (2 P15 @40 WAC, 1 P15 @40, free PF @20, return +40)
    expect(valuation.totalValue).toBeGreaterThan(0);

    const rl3 = await withTenant(tenant, (trx) => reconcile.rl3ValuationVsGl(trx, tenant, {}));
    expect(rl3.ok).toBe(true);
    expect(rl3.difference).toBe(0);

    const onHand = await withTenant(tenant, (trx) => inventory.stockOnHand(trx, tenant, {}));
    for (const row of onHand.rows) expect(row.drift).toBe(0);
  });

  it("RL-5: VAT report equals the VAT control accounts", async () => {
    const reconcile = await import("@/modules/reports/reconcile");
    const results = await withTenant(tenant, (trx) => reconcile.rl5VatVsGl(trx, tenant, {}));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.difference).toBe(0);
    }
    // input VAT: only the standard-rated purchase lines (2800 × 15% = 420)
    expect(results[1].left).toBeCloseTo(420, 2);
    // output VAT: 27 (cash sale) + 15 (paid sale) − 13.50 (credit note)
    expect(results[0].left).toBeCloseTo(28.5, 2);
  });

  it("reversals are first-class: they net to zero and never double count", async () => {
    const ledger = await import("@/modules/reports/ledger");
    const sales = await import("@/modules/reports/sales");

    const expense = (await db.execute(sql`
      select coalesce(sum(l.debit - l.credit), 0)::text as net
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.tenant_id = ${tenant} and l.account_id = ${accounts["5106"]}
    `)) as unknown as { rows: { net: string }[] };
    expect(Number(expense.rows[0].net)).toBe(0);

    const statement = await withTenant(tenant, (trx) =>
      ledger.accountLedger(trx, tenant, accounts["5106"], {}),
    );
    expect(statement.lines).toHaveLength(2);
    expect(statement.lines.filter((l) => l.isReversal)).toHaveLength(1);
    expect(statement.opening).toBe(0);
    expect(statement.closing).toBe(0);

    const income = await withTenant(tenant, (trx) => sales.incomeStatement(trx, tenant, {}));
    const manualAccount = income.byAccount.find((a) => a.accountId === accounts["5106"]);
    expect(manualAccount?.amount ?? 0).toBe(0);
    expect(income.netIncome).toBeCloseTo(income.revenue - income.expense, 2);
  });

  it("runs the full RL pack and reports zero breaches", async () => {
    const reconcile = await import("@/modules/reports/reconcile");
    const report = await withTenant(tenant, (trx) => reconcile.runReconciliations(trx, tenant, {}, TODAY));
    const breaches = report.results.filter((r) => !r.ok);
    expect(breaches, JSON.stringify(breaches, null, 2)).toEqual([]);
    expect(report.breaches).toBe(0);
    expect(report.results.map((r) => r.code)).toEqual(["RL-1", "RL-2", "RL-2", "RL-3", "RL-4", "RL-5", "RL-5"]);
  });

  it("excludes drafts from every figure and honours business-date filters", async () => {
    const sales = await import("@/modules/reports/sales");
    const inRange = await withTenant(tenant, (trx) => sales.salesByDimension(trx, tenant, { from: DAY(-2), to: DAY(-1) }, "date"));
    const outOfRange = await withTenant(tenant, (trx) =>
      sales.salesByDimension(trx, tenant, { from: DAY(1), to: DAY(30) }, "date"),
    );
    expect(outOfRange.rows).toHaveLength(0);
    expect(outOfRange.totals.net).toBe(0);
    expect(inRange.totals.net).toBeCloseTo(180 + 180 + 100, 2);
    // the credit note is dated today and is signed negative
    const withReturn = await withTenant(tenant, (trx) =>
      sales.salesByDimension(trx, tenant, { from: DAY(0), to: DAY(0) }, "date"),
    );
    expect(withReturn.totals.net).toBeCloseTo(-90, 2);

    const drafts = await withTenant(tenant, (trx) => sales.postedInvoiceCount(trx, tenant, {}));
    const allDocs = await scalar(
      sql`select count(*)::text from sales_invoices where tenant_id = ${tenant}`,
    );
    expect(Number(allDocs)).toBe(drafts + 1); // exactly the one draft we created
  });

  it("reports the tax submission queue without inventing a platform status", async () => {
    const tax = await import("@/modules/reports/tax");
    const status = await withTenant(tenant, (trx) => tax.submissionStatus(trx, tenant, {}));
    const queue = await withTenant(tenant, (trx) => tax.submissionActionQueue(trx, tenant));
    // tax is enabled but no EGS credential exists and the documents are unsigned, so
    // every submission is blocked_config with the validator's own diagnostic — the
    // report never invents a "reported"/"cleared" state (Phase 6 discipline)
    expect(status.total).toBe(4);
    expect(status.byStatus.every((r) => r.status === "blocked_config")).toBe(true);
    expect(status.rejected).toBe(0);
    expect(status.pending).toBe(0);
    expect(queue.length).toBe(status.total);
    expect(queue.every((q) => q.attempts === 0)).toBe(true);
    expect(queue.every((q) => (q.lastError ?? "").includes("BR-KSA"))).toBe(true);
    const reported = await scalar(sql`
      select count(*)::text from invoice_submissions
      where tenant_id = ${tenant} and status in ('reported', 'cleared')
    `);
    expect(Number(reported)).toBe(0);
  });

  it("withholds profitability when cost coverage is incomplete (never a fake margin)", async () => {
    const sales = await import("@/modules/reports/sales");
    const covered = await withTenant(tenant, (trx) => sales.profitability(trx, tenant, {}, "product"));
    expect(covered.coverage.complete).toBe(true);
    expect(covered.coverage.linesWithCost).toBe(covered.coverage.linesTotal);

    // the runtime refuses to CREATE a cost gap: a zero-cost receipt is blocked outright
    // (inventory/stock.ts) — so the report's caveat exists for data that predates it
    const { receiveStock } = await import("@/modules/inventory/stock");
    const newProduct = newId();
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, tax_category, sale_price)
      values (${newProduct}, ${tenant}, ${"NC-" + RUN}, 'صنف بلا تكلفة', ${unitEa}, 'standard', '10.00')
    `);
    await expect(
      withTenant(tenant, (trx) =>
        receiveStock(trx, ctx(), {
          warehouseId,
          productId: newProduct,
          qty: "5",
          unitCost: "0",
          businessDate: TODAY,
          sourceType: "test",
          sourceId: newId(),
          effectKind: "adjustment",
          lineRef: `nocost-${RUN}`,
        }),
      ),
    ).rejects.toThrow(/zeroCostBlocked/);

    // a legacy posted line whose cost was never captured cannot even be created today:
    // posted lines are immutable (INV-03 trigger). Such a row can only arrive through a
    // data import, so the fixture reproduces exactly that — a legacy document inserted
    // outside the API — and then asks the two features that exist for it:
    const legacyId = newId();
    await db.execute(sql`
      insert into sales_invoices (id, tenant_id, invoice_type, customer_id, warehouse_id, business_date,
                                  is_credit, subtotal, discount_total, vat_total, total, invoice_no,
                                  business_status, inventory_status, accounting_status, posted_at, created_by)
      values (${legacyId}, ${tenant}, 'sale', ${vatCustomerId}, ${warehouseId}, ${TODAY},
              true, '50.00', '0.00', '7.50', '57.50', 900,
              'draft', 'none', 'none', null, ${actorId})
    `);
    await db.execute(sql`
      insert into sales_invoice_lines (id, tenant_id, invoice_id, line_no, line_kind, product_id,
                                       qty_base, unit_price, net_amount, vat_rate, vat_amount, total_amount, line_cogs)
      values (${newId()}, ${tenant}, ${legacyId}, 1, 'normal', ${newProduct},
              '5', '10.00', '50.00', '0.15', '7.50', '57.50', null)
    `);
    // the line is fixed before the document is marked posted (the order the trigger allows)
    await db.execute(sql`
      update sales_invoices set business_status = 'posted', inventory_status = 'issued',
                                accounting_status = 'posted', posted_at = now()
      where id = ${legacyId}
    `);

    // 1. the profitability report WITHHOLDS a margin instead of valuing the row at zero
    const gapped = await withTenant(tenant, (trx) => sales.profitability(trx, tenant, {}, "product"));
    expect(gapped.coverage.complete).toBe(false);
    expect(gapped.coverage.linesWithCost).toBe(gapped.coverage.linesTotal - 1);

    // 2. the integrity audit names the document as having no journal effect at all
    const reconcile = await import("@/modules/reports/reconcile");
    const missing = await withTenant(tenant, (trx) => reconcile.postingsMissingForPostedDocs(trx, tenant));
    expect(missing.map((m) => m.sourceId)).toContain(legacyId);
  });

  it("serves every ready report through one contract, and says so when one is pending", async () => {
    const reports = await import("@/modules/reports");
    const { ar } = await import("@/i18n/ar");
    const { en } = await import("@/i18n/en");
    const dicts = [ar, en] as unknown as Record<string, unknown>[];
    const lookup = (dict: Record<string, unknown>, key: string) =>
      key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);

    const ready = reports.REPORT_CATALOG.filter((d) => d.status === "ready");
    expect(ready.length).toBeGreaterThan(25);
    expect(reports.REPORT_CATALOG.filter((d) => d.status === "pending").every((d) => Boolean(d.pendingReason))).toBe(true);

    for (const def of reports.REPORT_CATALOG) {
      // every report must be titled in BOTH dictionaries (a raw key would reach the user)
      for (const dict of dicts) expect(lookup(dict as Record<string, unknown>, def.titleKey), `${def.code} ${def.titleKey}`).toBeTruthy();

      if (def.status === "pending") {
        await expect(
          withTenant(tenant, (trx) => reports.runReport(trx, tenant, def.code, { from: DAY(-30), to: DAY(0), asOf: TODAY })),
        ).rejects.toThrow(/not implemented/);
        continue;
      }

      const result = await withTenant(tenant, (trx) =>
        reports.runReport(trx, tenant, def.code, {
          from: DAY(-30),
          to: DAY(0),
          asOf: TODAY,
          dim: def.dims?.[0].key,
          accountId: accounts["4101"],
        }),
      );
      expect(result.code).toBe(def.code);
      // no NaN/nullable number ever reaches the screen
      for (const row of result.rows) {
        for (const cell of row.cells) {
          if (typeof cell === "number") expect(Number.isFinite(cell), `${def.code} finite cell`).toBe(true);
        }
      }
      for (const column of result.columns) {
        for (const dict of dicts) expect(lookup(dict as Record<string, unknown>, column.titleKey), `${def.code} ${column.titleKey}`).toBeTruthy();
      }
      // the figures must be the same as the service the report wraps (no second query path)
      if (def.code === "R-20") {
        const sales = await import("@/modules/reports/sales");
        const direct = await withTenant(tenant, (trx) => sales.salesByDimension(trx, tenant, { from: DAY(-30), to: DAY(0) }, "date"));
        expect(result.totals?.[2]).toBeCloseTo(direct.totals.net, 2);
      }
      if (def.code === "R-42") {
        const reconcile = await import("@/modules/reports/reconcile");
        const rl3 = await withTenant(tenant, (trx) => reconcile.rl3ValuationVsGl(trx, tenant, {}));
        expect(result.totals?.[5]).toBeCloseTo(rl3.left, 2);
      }
    }
  });

  it("explains a valuation↔control difference instead of hiding it (RL-3 diagnostic)", async () => {
    const inventory = await import("@/modules/reports/inventory");
    const reconcile = await import("@/modules/reports/reconcile");

    // baseline: whatever the fixture already left behind (the previous test imported a
    // legacy invoice with no journal entry, which RL-5 must flag — see the note below)
    const before = await withTenant(tenant, (trx) => reconcile.runReconciliations(trx, tenant, {}, TODAY));
    // the imported document has VAT but no journal entry, so the VAT report cannot tie to
    // the control account — that breach is REAL and the note says why
    expect(before.results.filter((r) => !r.ok).map((r) => r.code)).toEqual(["RL-5"]);
    const outputVatBreach = before.results.find((r) => !r.ok && r.titleKey === "rep.outputVat");
    expect(outputVatBreach?.note ?? "").toContain("no journal entry");

    // a movement created outside the posting paths: the ledger holds the value, no entry exists
    const ghost = newId();
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, tax_category, sale_price)
      values (${ghost}, ${tenant}, ${"GL-" + RUN}, 'صنف بلا قيد', ${unitEa}, 'standard', '10.00')
    `);
    const { receiveStock, recordMovement } = await import("@/modules/inventory/stock");
    await withTenant(tenant, (trx) =>
      receiveStock(trx, ctx(), {
        warehouseId,
        productId: ghost,
        qty: "5",
        unitCost: "4.00",
        businessDate: TODAY,
        sourceType: "import",
        sourceId: newId(),
        effectKind: "adjustment",
        lineRef: `ghost-${RUN}`,
      }),
    );

    const audit = await withTenant(tenant, (trx) => inventory.stockMovementsWithoutJournal(trx, tenant, {}));
    expect(audit.count).toBe(1);
    expect(audit.value).toBeCloseTo(20, 2);

    const rl3 = await withTenant(tenant, (trx) => reconcile.rl3ValuationVsGl(trx, tenant, {}));
    expect(rl3.ok).toBe(false);
    expect(rl3.difference).toBeCloseTo(20, 2);
    // the note names the cause (and the same figure) instead of leaving a bare delta
    expect(rl3.note ?? "").toContain("no journal effect on the inventory control account");
    expect(rl3.note ?? "").toContain("20.00");

    const after = await withTenant(tenant, (trx) => reconcile.runReconciliations(trx, tenant, {}, TODAY));
    expect(after.breaches).toBe(before.breaches + 1);

    // removing the movement restores the reconciliation (the rule is not sticky)
    await withTenant(tenant, (trx) =>
      recordMovement(trx, ctx(), {
        warehouseId,
        productId: ghost,
        qty: "5",
        movementType: "adjustment_minus",
        businessDate: TODAY,
        sourceType: "import",
        sourceId: newId(),
        effectKind: "adjustment",
        lineRef: `ghost-reverse-${RUN}`,
        memo: "إزالة حركة بلا قيد",
      }),
    );
    const clean = await withTenant(tenant, (trx) => reconcile.rl3ValuationVsGl(trx, tenant, {}));
    expect(clean.ok).toBe(true);
    expect(clean.difference).toBe(0);
  });
});