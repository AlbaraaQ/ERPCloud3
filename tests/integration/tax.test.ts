/**
 * Tax / e-invoicing (Phase 6): config gating, classification, signed XML,
 * ICV+PIH chain, TLV QR integrity, transport outcomes, no-fabrication rules,
 * retry discipline, blocked posting without required config (INV-17).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;
const RUN = Math.random().toString(36).slice(2, 8);
const TODAY = "2026-07-20";

describe.skipIf(!DB)("tax — zatca submission engine", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  let tenantA = "";
  let tenantB = "";
  let actorId = "";
  let mainWh = "";
  let unitEa = "";
  let productA = "";
  let vatCustomerId = "";
  const ctx = () => ({ tenantId: tenantA, actorId });
  const ctxB = () => ({ tenantId: tenantB, actorId: null as string | null });

  async function scalar(q: ReturnType<typeof sql>, tenant = tenantA): Promise<string> {
    void tenant;
    const r = (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
    return Object.values(r.rows[0])[0] as string;
  }

  function decodeTlv(b64: string): { tag: number; value: Buffer }[] {
    const buf = Buffer.from(b64, "base64");
    const out: { tag: number; value: Buffer }[] = [];
    let i = 0;
    while (i + 2 <= buf.length) {
      const tag = buf[i];
      const len = buf[i + 1];
      out.push({ tag, value: buf.subarray(i + 2, i + 2 + len) });
      i += 2 + len;
    }
    return out;
  }

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    ({ withTenant } = await import("@/modules/shared/db-context"));
    ({ newId } = await import("@/modules/shared/ids"));
    const tenants = (await db.execute(sql`select id from tenants order by created_at asc limit 2`)) as unknown as { rows: { id: string }[] };
    tenantA = tenants.rows[0].id;
    tenantB = tenants.rows[1].id;
    actorId = await scalar(sql`select id from users where tenant_id = ${tenantA} order by created_at asc limit 1`);
    mainWh = await scalar(sql`select id from warehouses where tenant_id = ${tenantA} and code = 'MAIN'`);
    unitEa = await scalar(sql`select id from units where tenant_id = ${tenantA} and code = 'EA'`);

    // fresh product + stock on tenant A
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, track_lots, track_expiry, tax_category, sale_price)
      values (${newId()}, ${tenantA}, ${"TAX-" + RUN}, 'صنف ضريبي ٦٠', ${unitEa}, false, false, 'standard', '60.00')
    `);
    productA = await scalar(sql`select id from products where tenant_id = ${tenantA} and sku = ${"TAX-" + RUN}`);
    const { receiveStock } = await import("@/modules/inventory/stock");
    await withTenant(tenantA, (trx) =>
      receiveStock(trx, ctx(), {
        warehouseId: mainWh, productId: productA, qty: "50", unitCost: "30.00",
        businessDate: TODAY, sourceType: "test", sourceId: newId(), effectKind: `recv-tax-${RUN}`, lineRef: RUN,
      }),
    );

    // buyer with a 15-digit VAT (standard-document trigger)
    await db.execute(sql`
      insert into customers (id, tenant_id, code, name_ar, tax_number, credit_limit, payment_terms_days)
      values (${newId()}, ${tenantA}, ${"TAXC-" + RUN}, 'شركة مسجلة ضريبياً', '311122393500003', '10000', 30)
    `);
    vatCustomerId = await scalar(sql`select id from customers where tenant_id = ${tenantA} and code = ${"TAXC-" + RUN}`);

    // enable tax for tenant A with complete identity + device key
    await db.execute(sql`
      insert into tax_configs (tenant_id, enabled, env, city, postal_code, street, district, industry)
      values (${tenantA}, true, 'developer-portal', 'الرياض', '12345', 'طريق الملك فهد', 'العليا', 'أغذية')
      on conflict (tenant_id) do update set enabled = true, city = 'الرياض', postal_code = '12345'
    `);
    const { generateDeviceKeys } = await import("@/modules/tax/crypto");
    const keys = generateDeviceKeys();
    await db.execute(sql`
      insert into zatca_certificates (id, tenant_id, env, kind, label, private_key, public_key, status)
      values (${newId()}, ${tenantA}, 'developer-portal', 'device_key', 'test-egs', ${keys.privateKeyPem}, ${keys.publicKeySpkiPem}, 'active')
    `);
    // production credential (test-fake BST/secret for the transport boundary)
    await db.execute(sql`
      insert into zatca_certificates (id, tenant_id, env, kind, label, binary_security_token, secret, status)
      values (${newId()}, ${tenantA}, 'developer-portal', 'production', 'test-pcsid', 'dGVzdA==', 'c2VjcmV0', 'active')
    `);
  });

  afterAll(async () => {
    await db.execute(sql`update tax_configs set enabled = false where tenant_id = ${tenantA}`);
    delete process.env.ZATCA_TRANSPORT;
  });

  it("classification: VAT-registered buyer → standard; walk-in → simplified", async () => {
    const { classifyInvoice } = await import("@/modules/tax/config");
    await withTenant(tenantA, async (trx) => {
      expect((await classifyInvoice(trx, tenantA, vatCustomerId, "sale")).docType).toBe("standard");
      expect((await classifyInvoice(trx, tenantA, null, "sale")).docType).toBe("simplified");
      expect((await classifyInvoice(trx, tenantA, vatCustomerId, "sale_return")).docSubtype).toBe("credit_note");
    });
  });

  it("signed simplified invoice: XML, ICV+PIH chain, hash, real TLV QR (tags 1–9)", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const { computeInvoiceHash } = await import("@/modules/tax/xml");
    const { normalizeXmlForHash } = await import("@/modules/tax/submissions");
    const { initialPih } = await import("@/modules/tax/crypto");

    
    // Post BOTH invoices inside ONE tenant-lock section: posting transactions
    // serialize per tenant, so the pair's ICVs are consecutive regardless of
    // other suites running in parallel (still validated in full runs).
    const { inv, inv2, expectedIcv, expectedPih } = await withTenant(tenantA, async (trx) => {
      const chainRow = (await trx.execute(sql`
        select icv, last_hash from invoice_chains where id = ${tenantA + ":main"}
        for update
      `)) as unknown as { rows: { icv: number; last_hash: string }[] };
      const baseIcv = chainRow.rows[0] ? Number(chainRow.rows[0].icv) : 0;
      const basePih = chainRow.rows[0]?.last_hash || initialPih();
      const inv = await createAndPostInvoice(trx, ctx(), {
        customerId: null, warehouseId: mainWh, businessDate: TODAY, isCredit: false,
        lines: [{ productId: productA, qtyBase: "2" }], // 120 + 18 = 138
        paymentLines: [{ method: "cash", amount: "138.00" }],
      }, false);
      const inv2 = await createAndPostInvoice(trx, ctx(), {
        customerId: null, warehouseId: mainWh, businessDate: TODAY, isCredit: false,
        lines: [{ productId: productA, qtyBase: "1" }],
        paymentLines: [{ method: "cash", amount: "69.00" }],
      }, false);
      return { inv, inv2, expectedIcv: baseIcv + 1, expectedPih: basePih };
    });

    expect(expectedIcv).toBeGreaterThanOrEqual(1);

    const sub = (
      (await db.execute(sql`select * from invoice_submissions where invoice_id = ${inv.invoiceId}`)) as unknown as {
        rows: Record<string, unknown>[];
      }
    ).rows[0];
    expect(sub).toBeTruthy();
    expect(sub.doc_type).toBe("simplified");
    expect(sub.status).toBe("issued_pending_reporting");
    expect(Number(sub.icv)).toBe(expectedIcv);
    expect(sub.previous_hash).toBe(expectedPih);

    const xml = sub.xml as string;
    expect(xml).toContain("310122393500003"); // seller VAT from seed COA company
    expect(xml).toContain(`<cbc:UUID>${sub.invoice_uuid}</cbc:UUID>`.replace(/cb[ce]:UUID/g, "cbc:UUID"));
    expect(xml).toContain(`<cbc:UUID>${expectedIcv}</cbc:UUID>`); // ICV (relative)
    expect(xml).toContain('name="0200000"'); // simplified type code
    expect(computeInvoiceHash(xml).b64).toBe(sub.invoice_hash);

    // signature exists and normalizes back to the stored hash
    expect(sub.signature_value).toBeTruthy();
    expect(normalizeXmlForHash(xml).length).toBeLessThan(xml.length);

    // TLV QR integrity
    const parts = decodeTlv(sub.qr_base64 as string);
    expect(parts.map((p) => p.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parts[1].value.toString("utf8")).toBe("310122393500003");
    expect(parts[3].value.toString("utf8")).toBe("138.00");
    expect(parts[5].value.toString("utf8")).toBe(sub.invoice_hash);
    expect(parts[7].value.length).toBe(65); // 0x04 || X || Y (uncompressed)
    expect(parts[6].value.toString("utf8").length).toBeGreaterThan(60); // real signature

    // chain continuity on the second invoice (posted in the same locked section)
    const sub2 = (
      (await db.execute(sql`select * from invoice_submissions where invoice_id = ${inv2.invoiceId}`)) as unknown as {
        rows: Record<string, unknown>[];
      }
    ).rows[0];
    expect(Number(sub2.icv)).toBe(expectedIcv + 1);
    expect(sub2.previous_hash).toBe(sub.invoice_hash);

    const invTax = await scalar(sql`select tax_status from sales_invoices where id = ${inv.invoiceId}`);
    expect(invTax).toBe("issued_pending_reporting");
  });

  it("standard invoice → clearance_pending with 5-tag QR", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const inv = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId: vatCustomerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId: productA, qtyBase: "1" }],
      }, false),
    );
    const sub = (
      (await db.execute(sql`select * from invoice_submissions where invoice_id = ${inv.invoiceId}`)) as unknown as {
        rows: Record<string, unknown>[];
      }
    ).rows[0];
    expect(sub.doc_type).toBe("standard");
    expect(sub.status).toBe("clearance_pending");
    const parts = decodeTlv(sub.qr_base64 as string);
    expect(parts.map((p) => p.tag)).toEqual([1, 2, 3, 4, 5]);
  });

  it("processing via gated mock transport: reported/cleared, mirrors invoice, retry same uuid/icv", async () => {
    process.env.ZATCA_TRANSPORT = "mock";
    const { processPendingSubmissions, retrySubmission } = await import("@/modules/tax/processor");

    // this run's pending submissions (tests above created them; older run
    // artifacts may also be queued, so assert on OUR created ones)
    const before = (
      (await db.execute(sql`
        select id, doc_type from invoice_submissions
        where tenant_id = ${tenantA} and status in ('issued_pending_reporting', 'clearance_pending', 'failed_retryable')
        order by icv desc limit 6
      `)) as unknown as { rows: { id: string; doc_type: string }[] }
    ).rows;
    expect(before.length).toBeGreaterThanOrEqual(2);

    const results = await processPendingSubmissions(50);
    const resultsById = new Map(results.map((r) => [r.submissionId, r.outcome]));
    const ours = before.filter((b) => resultsById.has(b.id));
    expect(ours.some((b) => b.doc_type === "simplified" && resultsById.get(b.id) === "reported")).toBe(true);
    expect(ours.some((b) => b.doc_type === "standard" && resultsById.get(b.id) === "cleared")).toBe(true);

    // pick one and retry PROTOCOL: force back to pending → same uuid/icv
    const one = (
      (await db.execute(sql`
        select * from invoice_submissions where tenant_id = ${tenantA} and doc_type = 'simplified' order by icv limit 1
      `)) as unknown as { rows: Record<string, unknown>[] }
    ).rows[0];
    await withTenant(tenantA, async (trx) => {
      const { sql } = await import("drizzle-orm");
      await trx.execute(sql`
        update invoice_submissions set status = 'failed_retryable' where id = ${one.id}
      `);
    });
    await retrySubmission(tenantA, one.id as string, actorId);
    const again = await processPendingSubmissions(50);
    void again;
    const after = (
      (await db.execute(sql`select * from invoice_submissions where id = ${one.id}`)) as unknown as {
        rows: Record<string, unknown>[];
      }
    ).rows[0];
    expect(after.invoice_uuid).toBe(one.invoice_uuid);
    expect(after.icv).toBe(one.icv);
    expect(Number(after.attempts)).toBeGreaterThan(0);
    expect(["reported", "issued_pending_reporting"]).toContain(after.status);

    // integrity anomaly: corrupt one submission's stored hash → mock validation
    // must reject it, and the mirror on the invoice turns rejected (never resubmitted)
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const corrupted = await withTenant(tenantA, (trx) =>
      createAndPostInvoice(trx, ctx(), {
        customerId: null, warehouseId: mainWh, businessDate: TODAY, isCredit: false,
        lines: [{ productId: productA, qtyBase: "1" }],
        paymentLines: [{ method: "cash", amount: "69.00" }],
      }, false),
    );
    await db.execute(sql`
      update invoice_submissions set invoice_hash = 'Tk9ULUEtVkFMSUQtSEFTSA=='
      where invoice_id = ${corrupted.invoiceId}
    `);
    const res2 = await processPendingSubmissions(50);
    const corruptOutcome = res2.find((r) => {
      return r.outcome === "rejected";
    });
    expect(corruptOutcome).toBeTruthy();
    const corruptStatus = await scalar(sql`select status from invoice_submissions where invoice_id = ${corrupted.invoiceId}`);
    expect(corruptStatus).toBe("rejected");
    const corruptMirror = await scalar(sql`select tax_status from sales_invoices where id = ${corrupted.invoiceId}`);
    expect(corruptMirror).toBe("rejected");
  });

  it("tenant B: disabled → no submission; enabled w/o device key → blocked_config (never fabricated)", async () => {
    const { createAndPostInvoice } = await import("@/modules/sales/invoices");
    const { receiveStock } = await import("@/modules/inventory/stock");

    // deterministic baseline: clear tenant-B submission artifacts from earlier runs
    await db.execute(sql`delete from invoice_submissions where tenant_id = ${tenantB}`);
    await db.execute(sql`update tax_configs set enabled = false where tenant_id = ${tenantB}`);

    // stock on tenant B
    const [prodBId] = await Promise.all([
      scalar(sql`select id from products where tenant_id = ${tenantB} and sku = 'FG-JUICE-OR1' limit 1`),
    ]);
    const mainB = await scalar(sql`select id from warehouses where tenant_id = ${tenantB} and code = 'MAIN'`);
    await withTenant(tenantB, (trx) =>
      receiveStock(trx, ctxB(), {
        warehouseId: mainB, productId: prodBId, qty: "10", unitCost: "5.00",
        lot: { batchNo: `B-TAX-${RUN}` },
        businessDate: TODAY, sourceType: "test", sourceId: newId(), effectKind: `recvB-${RUN}`, lineRef: RUN,
      }),
    );

    // disabled by default → no submission rows on B
    const invB1 = await withTenant(tenantB, (trx) =>
      createAndPostInvoice(trx, ctxB(), {
        customerId: null, warehouseId: mainB, businessDate: TODAY, isCredit: false,
        lines: [{ productId: prodBId, qtyBase: "1" }],
        paymentLines: [{ method: "cash", amount: "7.48" }],
      }, false),
    );
    const cntDissabled = await scalar(sql`select count(*)::text from invoice_submissions where tenant_id = ${tenantB}`);
    expect(Number(cntDissabled)).toBe(0);

    // enable without device key → blocked_config + local_draft mirror
    await db.execute(sql`
      insert into tax_configs (tenant_id, enabled, env, city, postal_code)
      values (${tenantB}, true, 'developer-portal', 'جدة', '23456')
      on conflict (tenant_id) do update set enabled = true
    `);
    const invB2 = await withTenant(tenantB, (trx) =>
      createAndPostInvoice(trx, ctxB(), {
        customerId: null, warehouseId: mainB, businessDate: TODAY, isCredit: false,
        lines: [{ productId: prodBId, qtyBase: "1" }],
        paymentLines: [{ method: "cash", amount: "7.48" }],
      }, false),
    );
    const sub = (
      (await db.execute(sql`select status from invoice_submissions where invoice_id = ${invB2.invoiceId}`)) as unknown as { rows: { status: string }[] }
    ).rows[0];
    expect(sub.status).toBe("blocked_config");
    const mirror = await scalar(sql`select tax_status from sales_invoices where id = ${invB2.invoiceId}`);
    expect(mirror).toBe("local_draft");
    await db.execute(sql`update tax_configs set enabled = false where tenant_id = ${tenantB}`);
  });

  it("missing seller identity with tax enabled blocks posting (INV-17; no silent default)", async () => {
    const { createInvoiceDraft, postInvoice } = await import("@/modules/sales/invoices");
    const { isDomainError } = await import("@/modules/shared/result");

    await db.execute(sql`
      update tax_configs set enabled = true, city = null, postal_code = null where tenant_id = ${tenantA}
    `);
    await db.execute(sql`
      insert into products (id, tenant_id, sku, name_ar, stock_unit_id, tax_category, sale_price)
      select ${newId()}, ${tenantA}, ${"TAX2-" + RUN}, 'صنف إعداد-ناقص', u.id, 'standard', '10.00'
      from units u where u.tenant_id = ${tenantA} and u.code = 'EA' limit 1
    `);
    const prodId = await scalar(sql`select id from products where tenant_id = ${tenantA} and sku = ${"TAX2-" + RUN}`);
    const { receiveStock } = await import("@/modules/inventory/stock");
    await withTenant(tenantA, (trx) =>
      receiveStock(trx, ctx(), {
        warehouseId: mainWh, productId: prodId, qty: "5", unitCost: "4.00",
        businessDate: TODAY, sourceType: "test", sourceId: newId(), effectKind: `recv-tax2-${RUN}`, lineRef: RUN,
      }),
    );

    // credit path (registered buyer) so the flow reaches tax config validation
    // (walk-in cash route blocks earlier on full-payment rules, by design)
    const draftId = await withTenant(tenantA, (trx) =>
      createInvoiceDraft(trx, ctx(), {
        customerId: vatCustomerId, warehouseId: mainWh, businessDate: TODAY, isCredit: true,
        lines: [{ productId: prodId, qtyBase: "1" }],
      }, false),
    );
    const err = await withTenant(tenantA, (trx) => postInvoice(trx, ctx(), draftId, {})).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect(err.kind).toBe("ConfigurationError");
    expect(err.messageKey).toBe("errors.taxConfigIncomplete");
    const st = await scalar(sql`select business_status from sales_invoices where id = ${draftId}`);
    expect(st).toBe("draft"); // unchanged

    await db.execute(sql`
      update tax_configs set enabled = true, city = 'الرياض', postal_code = '12345' where tenant_id = ${tenantA}
    `);
  });
});
