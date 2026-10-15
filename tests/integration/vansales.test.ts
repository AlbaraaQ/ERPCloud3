/**
 * Van sales & settlement (Phase 4): provisioning invariants (AC-001/002),
 * sync apply idempotency + tamper, custody-scoped ops, settlement lifecycle
 * with concurrency (AC-015/016/017/018 mapped).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;
const RUN = Math.random().toString(36).slice(2, 8);
const TODAY = "2026-05-12";

describe.skipIf(!DB)("vansales — provisioning, sync, settlement", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  let tenantA = "";
  let repUserId = "";
  let accUserId = "";
  let whUserId = "";
  let normCustomerId = "";
  let juiceId = "";
  let mainWh = "";
  let custodyWh = "";
  let deviceId = "";
  const repCtx = () => ({ tenantId: tenantA, actorId: repUserId });
  const accCtx = () => ({ tenantId: tenantA, actorId: accUserId });

  async function scalar(q: ReturnType<typeof sql>): Promise<string> {
    const r = (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
    return Object.values(r.rows[0])[0] as string;
  }

  async function balance(warehouseId: string, productId: string): Promise<number> {
    const v = await scalar(sql`
      select coalesce(on_hand, 0)::text from stock_balances
      where tenant_id = ${tenantA} and warehouse_id = ${warehouseId} and product_id = ${productId}
    `);
    return Number(v);
  }

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    ({ withTenant } = await import("@/modules/shared/db-context"));
    ({ newId } = await import("@/modules/shared/ids"));
    tenantA = await scalar(sql`select id from tenants order by created_at asc limit 1`);
    repUserId = await scalar(sql`select id from users where tenant_id = ${tenantA} and email = 'rep@horizon.test'`);
    accUserId = await scalar(sql`select id from users where tenant_id = ${tenantA} and email = 'acc@horizon.test'`);
    whUserId = await scalar(sql`select id from users where tenant_id = ${tenantA} and email = 'wh@horizon.test'`);
    mainWh = await scalar(sql`select id from warehouses where tenant_id = ${tenantA} and code = 'MAIN'`);
    juiceId = await scalar(sql`select id from products where tenant_id = ${tenantA} and sku = 'FG-JUICE-OR1'`);
    deviceId = newId();

    // custody warehouse for the demo rep (idempotent, regardless of run count)
    const { provisionRepresentative } = await import("@/modules/vansales/provisioning");
    const r = await withTenant(tenantA, (trx) =>
      provisionRepresentative(trx, { tenantId: tenantA, actorId: repUserId }, repUserId),
    );
    custodyWh = r.custodyWarehouseId;

    // top up seeded juice in MAIN so parallel suites can't drain it below dispatch needs
    const { receiveStock } = await import("@/modules/inventory/stock");
    await withTenant(tenantA, (trx) =>
      receiveStock(trx, { tenantId: tenantA, actorId: accUserId }, {
        warehouseId: mainWh,
        productId: juiceId,
        qty: "500",
        unitCost: "4.75",
        lot: { batchNo: `TOPUP-${RUN}`, expiryDate: "2027-06-30" },
        businessDate: TODAY,
        sourceType: "test", sourceId: newId(), effectKind: `juice-topup-${RUN}`, lineRef: RUN,
      }),
    );
  });

  it("AC-001/002: provisioning creates EXACTLY one custody warehouse (repeat + concurrent)", async () => {
    const { provisionRepresentative } = await import("@/modules/vansales/provisioning");
    // fresh rep user per run → the "first creation" assertion is deterministic
    await db.execute(sql`
      insert into users (id, tenant_id, email, password_hash, name)
      values (${newId()}, ${tenantA}, ${"vans-" + RUN + "@test"}, 'x', 'مندوب اختبار الحتمية')
    `);
    const freshUserId = await scalar(sql`select id from users where tenant_id = ${tenantA} and email = ${"vans-" + RUN + "@test"}`);
    const freshCtx = () => ({ tenantId: tenantA, actorId: accUserId });

    const r1 = await withTenant(tenantA, (trx) => provisionRepresentative(trx, freshCtx(), freshUserId));
    expect(r1.custodyWarehouseId).toBeTruthy();
    expect(r1.createdWarehouse).toBe(true);

    const countAfterFirst = await scalar(sql`
      select count(*)::text from warehouses where tenant_id = ${tenantA} and representative_user_id = ${freshUserId}
    `);
    expect(Number(countAfterFirst)).toBe(1);

    // sequential repeat — replay, no new warehouse
    const r2 = await withTenant(tenantA, (trx) => provisionRepresentative(trx, freshCtx(), freshUserId));
    expect(r2.custodyWarehouseId).toBe(r1.custodyWarehouseId);
    expect(r2.createdWarehouse).toBe(false);

    // concurrent double-assign — the DB unique constraint holds (AC-002)
    await Promise.allSettled([
      withTenant(tenantA, (trx) => provisionRepresentative(trx, freshCtx(), freshUserId)),
      withTenant(tenantA, (trx) => provisionRepresentative(trx, freshCtx(), freshUserId)),
    ]);
    const countAfterRace = await scalar(sql`
      select count(*)::text from warehouses where tenant_id = ${tenantA} and representative_user_id = ${freshUserId}
    `);
    expect(Number(countAfterRace)).toBe(1);
  });

  it("transfer to custody via sync ops: dispatch → rep accept (idempotent replay)", async () => {
    const { createTransferDraft, dispatchTransfer } = await import("@/modules/inventory/transfers");
    const { registerDevice } = await import("@/modules/vansales/provisioning");
    const { applySyncOp, hashPayload } = await import("@/modules/vansales/sync");
    const custodyBaseline = await balance(custodyWh, juiceId);

    // accountant dispatches 20 juice units to custody
    const tid = await withTenant(tenantA, (trx) =>
      createTransferDraft(trx, accCtx(), {
        fromWarehouseId: mainWh,
        toWarehouseId: custodyWh,
        businessDate: TODAY,
        lines: [{ productId: juiceId, qty: "20" }],
      }),
    );
    await withTenant(tenantA, (trx) => dispatchTransfer(trx, accCtx(), tid));

    // rep device registered
    await withTenant(tenantA, (trx) =>
      registerDevice(trx, repCtx(), { deviceId, userId: repUserId, label: "هاتف-اختبار" }),
    );

    // rep accepts via sync op (transfer.accept), then replays the same op
    const lineId = await scalar(sql`select id from transfer_lines where transfer_id = ${tid}`);
    const payload = {
      transferId: tid,
      accepts: [{ lineId, qty: "20" }],
      businessDate: TODAY,
    };
    const op = { opId: newId(), opType: "transfer.accept", payload, payloadHash: hashPayload(payload) };
    const r1 = await applySyncOp(repCtx(), deviceId, op);
    expect(r1.status).toBe("ack");
    expect(await balance(custodyWh, juiceId)).toBeCloseTo(custodyBaseline + 20, 4);

    const r2 = await applySyncOp(repCtx(), deviceId, op);
    expect(r2.status).toBe("replayed");
    expect(await balance(custodyWh, juiceId)).toBeCloseTo(custodyBaseline + 20, 4); // no double receive
  });

  it("invoice.create via sync: custody-scoped posts, idempotent replay, tamper reject", async () => {
    const { applySyncOp, hashPayload } = await import("@/modules/vansales/sync");
    const beforeSale = await balance(custodyWh, juiceId);
    const payload = {
      customerId: null,
      businessDate: TODAY,
      isCredit: false,
      lines: [{ productId: juiceId, qtyBase: "3" }],
      paymentLines: [{ method: "cash", amount: "22.43", reference: null }], // 19.50 + VAT HALF_UP 2.93 = 22.43
    };
    const op = { opId: newId(), opType: "invoice.create", payload, payloadHash: hashPayload(payload) };

    const ack = await applySyncOp(repCtx(), deviceId, op);
    expect(ack.status).toBe("ack");
    expect(ack.refs?.invoiceNo).toBeTypeOf("number");
    expect(await balance(custodyWh, juiceId)).toBeCloseTo(beforeSale - 3, 4);

    const replay = await applySyncOp(repCtx(), deviceId, op);
    expect(replay.status).toBe("replayed");
    expect(await balance(custodyWh, juiceId)).toBeCloseTo(beforeSale - 3, 4);

    // tamper: same opId, different payload
    const badPayload = { ...payload, lines: [{ productId: juiceId, qtyBase: "99" }] };
    const tamper = await applySyncOp(repCtx(), deviceId, {
      opId: op.opId,
      opType: "invoice.create",
      payload: badPayload,
      payloadHash: hashPayload(badPayload),
    });
    expect(tamper.status).toBe("tamper");
    expect(await balance(custodyWh, juiceId)).toBeCloseTo(beforeSale - 3, 4); // untouched
  });

  it("scope enforcement: user without custody gets rejected, not applied", async () => {
    const { applySyncOp, hashPayload } = await import("@/modules/vansales/sync");
    const { registerDevice } = await import("@/modules/vansales/provisioning");
    const whDevice = newId();
    await withTenant(tenantA, (trx) =>
      registerDevice(trx, { tenantId: tenantA, actorId: whUserId }, { deviceId: whDevice, userId: whUserId, label: "جهاز-مستودع" }),
    );
    const payload = {
      customerId: null,
      businessDate: TODAY,
      isCredit: false,
      lines: [{ productId: juiceId, qtyBase: "1" }],
      paymentLines: [{ method: "cash", amount: "7.475", reference: null }],
    };
    const res = await applySyncOp({ tenantId: tenantA, actorId: whUserId }, whDevice, {
      opId: newId(), opType: "invoice.create", payload, payloadHash: hashPayload(payload),
    });
    const unchanged = await balance(custodyWh, juiceId);
    expect(res.status).toBe("rejected");
    expect(res.messageKey).toBe("errors.noCustodyWarehouse");
    expect(await balance(custodyWh, juiceId)).toBeCloseTo(unchanged, 4);
  });

  it("credit sale + receipt via ops: allocation guard applies (INV-09)", async () => {
    const { applySyncOp, hashPayload } = await import("@/modules/vansales/sync");
    normCustomerId = await scalar(sql`select id from customers where tenant_id = ${tenantA} and code = 'CUST-002'`);

    const invPayload = {
      customerId: normCustomerId,
      businessDate: TODAY,
      isCredit: true,
      lines: [{ productId: juiceId, qtyBase: "2" }], // 12 + 1.8 = 13.8 (customer price 6.00)
    };
    const inv = await applySyncOp(repCtx(), deviceId, {
      opId: newId(), opType: "invoice.create", payload: invPayload, payloadHash: hashPayload(invPayload),
    });
    expect(inv.status).toBe("ack");
    const invoiceId = inv.refs?.invoiceId as string;

    const tooMuch = {
      customerId: normCustomerId,
      businessDate: TODAY,
      paymentLines: [{ method: "cash", amount: "20.00" }],
      allocations: [{ invoiceId, amount: "20.00" }],
    };
    const bad = await applySyncOp(repCtx(), deviceId, {
      opId: newId(), opType: "receipt.create", payload: tooMuch, payloadHash: hashPayload(tooMuch),
    });
    expect(bad.status).toBe("rejected");
    expect(bad.messageKey).toBe("errors.allocExceedsOutstanding");

    const good = {
      customerId: normCustomerId,
      businessDate: TODAY,
      paymentLines: [{ method: "cash", amount: "13.80" }],
      allocations: [{ invoiceId, amount: "13.80" }],
    };
    const ok = await applySyncOp(repCtx(), deviceId, {
      opId: newId(), opType: "receipt.create", payload: good, payloadHash: hashPayload(good),
    });
    expect(ok.status).toBe("ack");
  });

  it("settlement lifecycle: request → review → counts → exception → approval → close (immutable)", async () => {
    const s = await import("@/modules/vansales/settlement");

    // --- pre-clean: complete any leftover open settlement so state is deterministic
    const leftover = (
      (await db.execute(
        sql`select id, status from settlements where tenant_id = ${tenantA} and rep_user_id = ${repUserId} and status in ('requested', 'under_review') limit 1`,
      )) as unknown as { rows: { id: string; status: string }[] }
    ).rows[0];
    if (leftover) {
      await withTenant(tenantA, (trx) => s.openForReview(trx, accCtx(), leftover.id));
      const lns = (
        (await db.execute(
          sql`select product_id, expected_qty::text as e from settlement_lines where settlement_id = ${leftover.id}`,
        )) as unknown as { rows: { product_id: string; e: string }[] }
      ).rows;
      const expCash = await scalar(sql`select coalesce(expected_cash,'0')::text from settlements where id = ${leftover.id}`);
      await withTenant(tenantA, (trx) =>
        s.recordCounts(trx, accCtx(), leftover.id, {
          countedCash: expCash,
          lines: lns.map((l) => ({ productId: l.product_id, countedQty: l.e })),
        }),
      );
      let pendingIds = (
        (await db.execute(
          sql`select id from settlement_exceptions where settlement_id = ${leftover.id} and resolution = 'pending'`,
        )) as unknown as { rows: { id: string }[] }
      ).rows;
      for (const p of pendingIds) {
        await withTenant(tenantA, (trx) => s.approveException(trx, accCtx(), p.id, "تنظيف اختباري"));
      }
      await withTenant(tenantA, (trx) => s.closeSettlement(trx, accCtx(), leftover.id));
    }

    // cash baseline BEFORE this test's own invoice receipts (from earlier tests)
    const cashBaseline = Number(
      await scalar(sql`
        select (
          coalesce((select sum(rl.amount) from receipt_lines rl join receipts r on r.id = rl.receipt_id
            where r.tenant_id = ${tenantA} and r.created_by = ${repUserId} and rl.method in ('cash','bank_transfer')), 0)
        )::text
      `),
    );

    // request (rep) — idempotent
    const r1 = await withTenant(tenantA, (trx) => s.requestSettlement(trx, repCtx(), repUserId, TODAY));
    const r2 = await withTenant(tenantA, (trx) => s.requestSettlement(trx, repCtx(), repUserId, TODAY));
    expect(r1.settlementId).toBe(r2.settlementId);
    expect(r2.replayed).toBe(true);

    // open for review (accountant)
    await withTenant(tenantA, (trx) => s.openForReview(trx, accCtx(), r1.settlementId));
    const expectedCash = await scalar(sql`select expected_cash::text from settlements where id = ${r1.settlementId}`);
    expect(Number(expectedCash)).toBeCloseTo(cashBaseline, 3); // computed from authoritative receipts
    const lineCount = await scalar(sql`select count(*)::text from settlement_lines where settlement_id = ${r1.settlementId}`);
    expect(Number(lineCount)).toBeGreaterThan(0);

    // counts: juice short by 2, cash exact
    const juiceExpected = await scalar(sql`
      select expected_qty::text from settlement_lines where settlement_id = ${r1.settlementId} and product_id = ${juiceId}
    `);
    const juiceCounted = (Number(juiceExpected) - 2).toString();
    await withTenant(tenantA, (trx) =>
      s.recordCounts(trx, accCtx(), r1.settlementId, {
        countedCash: expectedCash,
        lines: [{ productId: juiceId, countedQty: juiceCounted }],
      }),
    );
    const pending = await scalar(sql`
      select count(*)::text from settlement_exceptions where settlement_id = ${r1.settlementId} and resolution = 'pending'
    `);
    expect(Number(pending)).toBeGreaterThan(0);

    // close blocked while exception pending
    const blocked = await withTenant(tenantA, (trx) => s.closeSettlement(trx, accCtx(), r1.settlementId)).catch((e) => e);
    expect(blocked.messageKey).toBe("errors.settlementPendingExceptions");

    // approve the exception, then close
    const excId = await scalar(sql`
      select id from settlement_exceptions where settlement_id = ${r1.settlementId} and resolution = 'pending' limit 1
    `);
    await withTenant(tenantA, (trx) => s.approveException(trx, accCtx(), excId, "تحقيق موثق"));

    const balanceBefore = await balance(custodyWh, juiceId);
    const [c1, c2] = await Promise.all([
      withTenant(tenantA, (trx) => s.closeSettlement(trx, accCtx(), r1.settlementId)),
      withTenant(tenantA, (trx) => s.closeSettlement(trx, accCtx(), r1.settlementId)),
    ]);
    // exactly one closes; the other is a replay (AC-018)
    expect([c1.replayed, c2.replayed].filter((x) => x === false).length).toBe(1);
    expect([c1.replayed, c2.replayed].filter((x) => x === true).length).toBe(1);

    // stock shortened by exactly 2 with a balanced GL entry
    expect(await balance(custodyWh, juiceId)).toBeCloseTo(balanceBefore - 2, 4);
    const gl = await scalar(sql`
      select (sum(l.debit::numeric) - sum(l.credit::numeric))::text
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.source_type = 'settlement' and e.source_id = ${r1.settlementId}
    `);
    expect(Number(gl)).toBeCloseTo(0, 4);

    // rep notified with final result
    const notif = await scalar(sql`
      select count(*)::text from notifications where user_id = ${repUserId} and kind = 'settlement.closed'
    `);
    expect(Number(notif)).toBeGreaterThan(0);

    // immutable at DB level
    const err: unknown = await db
      .execute(sql`update settlements set counted_cash = '0' where id = ${r1.settlementId}`)
      .catch((x: unknown) => x);
    expect(err instanceof Error).toBe(true);
  });

  it("unapproved shortage never becomes an employee debt (AC-016/D-022)", async () => {
    // after closure above, shortages existed ONLY via explicit approval;
    // assert no employee-receivable (1108) movement came from this settlement
    const empAcct = await scalar(sql`select id from accounts where tenant_id = ${tenantA} and code = '1108'`);
    const cnt = await scalar(sql`
      select count(*)::text from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where e.source_type = 'settlement' and l.account_id = ${empAcct}
    `);
    expect(Number(cnt)).toBe(0);
  });
});
