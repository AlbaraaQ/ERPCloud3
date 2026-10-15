/**
 * Sales invoice engine (FR-029…035, IZ §5). Both POS surfaces post ONLY via
 * this module. Four status dimensions stay orthogonal; drafts have no effects.
 */

import { and, eq } from "drizzle-orm";
import {
  customers,
  products,
  salesInvoices,
  salesInvoiceLines,
  allocations,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors, isDomainError } from "@/modules/shared/result";
import { Decimal, dec, roundMoney, toDb, sum } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { addDays } from "@/modules/shared/dates";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { recordMovement } from "@/modules/inventory/stock";
import { postEntry, nextDocNumber } from "@/modules/accounting/posting";
import { resolveMany } from "@/modules/accounting/mappings";
import { vatRateFor, resolveSalePrice, checkPriceBoundaries } from "./pricing";
import { sql } from "drizzle-orm";
import { createReceiptCore } from "./receipts";
import { customerExposure, advanceBalance, invoiceOutstanding } from "./balances";

export const VAT_RATE_STANDARD = "0.15";

export interface SaleLineInput {
  productId: string;
  qtyBase: string;
  /** optional selling price (override) — server validates against policy */
  unitPrice?: string;
  lineKind?: "normal" | "free";
  discountAmount?: string;
  overrideReason?: string;
}

export interface PaymentLineInput {
  method: "cash" | "bank_transfer" | "card" | "other";
  amount: string;
  treasuryAccountId?: string | null;
  reference?: string | null;
}

export interface SaleInvoiceInput {
  customerId: string | null;
  warehouseId: string;
  businessDate: string;
  isCredit: boolean;
  lines: SaleLineInput[];
  paymentLines?: PaymentLineInput[];
  salespersonUserId?: string | null;
  clientOpId?: string | null;
  dueDate?: string | null;
}

export interface ComputedLine {
  productId: string;
  lineKind: "normal" | "free";
  qtyBase: Decimal;
  unitPrice: Decimal;
  originalPrice: Decimal | null;
  overrideReason: string | null;
  discountAmount: Decimal;
  net: Decimal;
  vatRate: Decimal;
  vat: Decimal;
  total: Decimal;
  gross: Decimal;
}

/** Server-side computation: pricing, overrides, discounts, VAT (never trust client math). */
export async function computeSalesLines(
  trx: Trx,
  tenantId: string,
  lines: SaleLineInput[],
  opts: { customerId: string | null; date: string; canPriceOverride: boolean },
): Promise<ComputedLine[]> {
  if (lines.length === 0) throw errors.validation("errors.invoiceEmpty");
  const out: ComputedLine[] = [];
  for (const [i, l] of lines.entries()) {
    const qty = dec(l.qtyBase);
    if (qty.lte(0)) throw errors.validation("errors.qtyMustBePositive", undefined, { line: i + 1 });

    const [product] = await trx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, l.productId)))
      .limit(1);
    if (!product || !product.active) throw errors.validation("errors.productInvalid", l.productId, { line: i + 1 });

    const kind = l.lineKind ?? "normal";
    const resolved = await resolveSalePrice(trx, tenantId, {
      customerId: opts.customerId,
      productId: l.productId,
      onDate: opts.date,
    });

    let unitPrice: Decimal;
    let originalPrice: Decimal | null = null;
    if (kind === "free") {
      unitPrice = new Decimal(0);
      originalPrice = dec(resolved.price); // free goods keep the commercial price visible (D-021)
    } else if (l.unitPrice != null && l.unitPrice !== "" && !dec(l.unitPrice).eq(dec(resolved.price))) {
      const req = dec(l.unitPrice);
      if (req.lt(0)) throw errors.validation("errors.priceNegative", undefined, { line: i + 1 });
      const band = checkPriceBoundaries(
        { salePrice: product.salePrice, minPrice: product.minPrice, maxPrice: product.maxPrice },
        l.unitPrice,
      );
      if (!band.within) {
        if (!opts.canPriceOverride) {
          throw errors.validation("errors.priceOutOfBounds", undefined, {
            line: i + 1, violation: band.violation, min: band.min, max: band.max,
          });
        }
        if (!l.overrideReason) {
          throw errors.validation("errors.overrideReasonRequired", undefined, { line: i + 1 });
        }
      }
      unitPrice = req;
      originalPrice = dec(resolved.price);
    } else {
      unitPrice = dec(resolved.price);
    }

    const gross = roundMoney(qty.times(unitPrice));
    const discount = kind === "free" ? new Decimal(0) : roundMoney(l.discountAmount ?? "0");
    if (discount.lt(0) || discount.gt(gross)) {
      throw errors.validation("errors.discountInvalid", undefined, { line: i + 1 });
    }
    const net = roundMoney(gross.minus(discount));
    const vatRate = dec(vatRateFor(product.taxCategory));
    const vat = roundMoney(net.times(vatRate));
    out.push({
      productId: l.productId,
      lineKind: kind,
      qtyBase: qty,
      unitPrice,
      originalPrice,
      overrideReason: l.overrideReason ?? null,
      discountAmount: discount,
      net,
      vatRate,
      vat,
      total: net.plus(vat),
      gross,
    });
  }
  return out;
}

export function totalsOf(lines: ComputedLine[]) {
  const gross = sum(lines.filter((l) => l.lineKind === "normal").map((l) => toDb(l.gross)));
  const discount = sum(lines.map((l) => toDb(l.discountAmount)));
  const net = sum(lines.map((l) => toDb(l.net)));
  const vat = sum(lines.map((l) => toDb(l.vat)));
  const total = sum(lines.map((l) => toDb(l.total)));
  return { gross: roundMoney(gross), discount: roundMoney(discount), net: roundMoney(net), vat: roundMoney(vat), total: roundMoney(total) };
}

async function lockCustomer(trx: Trx, tenantId: string, customerId: string) {
  const [c] = await trx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
    .for("update")
    .limit(1);
  if (!c) throw errors.notFound("customer", customerId);
  return c;
}


/** Insert a draft invoice (no GL/stock effects, clearly non-final — IZ §5.B). */
export async function createInvoiceDraft(
  trx: Trx,
  ctx: ServiceCtx,
  input: SaleInvoiceInput,
  canPriceOverride: boolean,
): Promise<string> {
  if (input.clientOpId) {
    const [dup] = await trx
      .select({ id: salesInvoices.id })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.clientOpId, input.clientOpId)))
      .limit(1);
    if (dup) return dup.id; // idempotent replay
  }
  const computed = await computeSalesLines(trx, ctx.tenantId, input.lines, {
    customerId: input.customerId,
    date: input.businessDate,
    canPriceOverride,
  });
  const t = totalsOf(computed);
  const id = newId();
  // savepoint: concurrent same-clientOpId submit violates the unique index —
  // roll back and replay to the existing document (INV-02 sync-safe).
  const sp = input.clientOpId ? `hisab_inv_${newId().replace(/-/g, "").slice(0, 12)}` : null;
  if (sp) await trx.execute(sql`savepoint ${sql.raw(sp)}`);
  try {
    await trx.insert(salesInvoices).values({
    id,
    tenantId: ctx.tenantId,
    invoiceType: "sale",
    customerId: input.customerId,
    warehouseId: input.warehouseId,
    businessDate: input.businessDate,
    isCredit: input.isCredit,
    dueDate: input.dueDate ?? null,
    subtotal: toDb(t.net),
    discountTotal: toDb(t.discount),
    vatTotal: toDb(t.vat),
    total: toDb(t.total),
    salespersonUserId: input.salespersonUserId ?? ctx.actorId,
    clientOpId: input.clientOpId ?? null,
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
    await trx.insert(salesInvoiceLines).values(
      computed.map((l, i) => ({
        id: newId(),
        tenantId: ctx.tenantId,
        invoiceId: id,
        lineNo: i + 1,
        lineKind: l.lineKind,
        productId: l.productId,
        qtyBase: toDb(l.qtyBase),
        unitPrice: toDb(l.unitPrice),
        originalPrice: l.originalPrice ? toDb(l.originalPrice) : null,
        overrideReason: l.overrideReason,
        discountAmount: toDb(l.discountAmount),
        netAmount: toDb(l.net),
        vatRate: toDb(l.vatRate),
        vatAmount: toDb(l.vat),
        totalAmount: toDb(l.total),
      })),
    );
  } catch (e) {
    const code = ((): string | undefined => {
      let cur: unknown = e;
      while (cur && typeof cur === "object") {
        const c = (cur as { code?: string }).code;
        if (c) return c;
        cur = (cur as { cause?: unknown }).cause;
      }
      return undefined;
    })();
    if (sp && code === "23505" && input.clientOpId) {
      await trx.execute(sql`rollback to savepoint ${sql.raw(sp)}`);
      const [dup] = await trx
        .select({ id: salesInvoices.id })
        .from(salesInvoices)
        .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.clientOpId, input.clientOpId)))
        .limit(1);
      if (dup) return dup.id;
    }
    throw e;
  }
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "sales.invoice.draft_created",
    entity: "sales_invoice",
    entityId: id,
    after: { total: toDb(t.total), lines: computed.length },
  });
  return id;
}

/**
 * Post a draft invoice atomically: customer rules → stock issues (COGS) → GL
 * (P-01..P-04) → optional payment receipt — one transaction, replay-safe.
 */
export async function postInvoice(
  trx: Trx,
  ctx: ServiceCtx,
  invoiceId: string,
  opts: { paymentLines?: PaymentLineInput[] } = {},
): Promise<{ invoiceNo: number; replayed: boolean }> {
  const [inv] = await trx
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, invoiceId)))
    .for("update")
    .limit(1);
  if (!inv) throw errors.notFound("salesInvoice", invoiceId);
  if (inv.businessStatus === "posted") {
    return { invoiceNo: inv.invoiceNo!, replayed: true };
  }

  const lines = await trx
    .select()
    .from(salesInvoiceLines)
    .where(eq(salesInvoiceLines.invoiceId, invoiceId));
  if (lines.length === 0) throw errors.validation("errors.invoiceEmpty");

  // -------- customer rules
  let customer: typeof customers.$inferSelect | null = null;
  if (inv.customerId) customer = await lockCustomer(trx, ctx.tenantId, inv.customerId);
  if (customer?.creditHold) throw errors.validation("errors.customerOnHold", customer.code);
  if (inv.isCredit && !customer) throw errors.validation("errors.walkinCashOnly");

  const total = dec(inv.total);
  const paidNow = sum((opts.paymentLines ?? []).map((p) => p.amount));
  const exposureAfter = total.minus(paidNow);
  if (customer && exposureAfter.gt(0)) {
    const exposure = await customerExposure(trx, ctx.tenantId, customer.id);
    const limit = dec(customer.creditLimit);
    if (limit.gt(0) && exposure.plus(exposureAfter).gt(limit)) {
      throw errors.validation("errors.creditLimitExceeded", undefined, {
        limit: limit.toFixed(2),
        current: exposure.toFixed(2),
        invoice: exposureAfter.toFixed(2),
      });
    }
  }
  if (customer && inv.isCredit && !inv.dueDate) {
    const terms = customer.paymentTermsDays;
    if (terms > 0) {
      await trx
        .update(salesInvoices)
        .set({ dueDate: addDays(inv.businessDate, terms) })
        .where(eq(salesInvoices.id, invoiceId));
    }
  }

  // -------- stock issues + COGS capture
  let cogsNormal = new Decimal(0);
  let cogsFree = new Decimal(0);
  for (const l of lines) {
    const mv = await recordMovement(trx, ctx, {
      warehouseId: inv.warehouseId,
      productId: l.productId,
      qty: l.qtyBase,
      movementType: "issue",
      businessDate: inv.businessDate,
      sourceType: "sales_invoice",
      sourceId: invoiceId,
      effectKind: "sale_issue",
      lineRef: l.id,
      memo: "بيع",
    });
    const issueValue = dec(mv.value).abs();
    const cogs = issueValue;
    if (l.lineKind === "free") cogsFree = cogsFree.plus(cogs);
    else cogsNormal = cogsNormal.plus(cogs);
    // unit cost back to the line (immutable once posted — update while draft)
    await trx
      .update(salesInvoiceLines)
      .set({ unitCostValue: mv.unitCost, lineCogs: toDb(cogs) })
      .where(eq(salesInvoiceLines.id, l.id));
  }

  // -------- numbering + state transition (conditional → race-safe)
  const series = inv.invoiceType === "sale_return" ? "CN" : "SI";
  const invoiceNo = await nextDocNumber(trx, ctx.tenantId, series);
  const [posted] = await trx
    .update(salesInvoices)
    .set({
      businessStatus: "posted",
      inventoryStatus: "issued",
      accountingStatus: "posted",
      invoiceNo,
      postedAt: new Date(),
      postedBy: ctx.actorId,
    })
    .where(and(eq(salesInvoices.id, invoiceId), eq(salesInvoices.businessStatus, "draft")))
    .returning({ id: salesInvoices.id });
  if (!posted) return { invoiceNo, replayed: true };

  // -------- GL (P-01…P-04)
  // Named customers: Dr AR for the FULL invoice — the receipt (same tx) settles it.
  // Walk-in: payment is required in full and posts straight to treasury.
  const net = dec(inv.subtotal);
  const vat = dec(inv.vatTotal);
  const gross = net.plus(dec(inv.discountTotal));
  const disc = dec(inv.discountTotal);
  const isWalkIn = !inv.customerId;
  const paymentLines = opts.paymentLines ?? [];
  const METHOD_KEY: Record<string, string> = {
    cash: "cash_default",
    bank_transfer: "bank_default",
    card: "card_clearing",
    other: "bank_default",
  };
  if (isWalkIn && paidNow.lt(total)) {
    throw errors.validation("errors.walkinMustPayFull");
  }
  const neededKeys = new Set<string>([
    "ar_control", "sales", "output_vat", "cogs", "inventory_control",
  ]);
  if (cogsFree.gt(0)) neededKeys.add("free_goods_expense");
  if (disc.gt(0)) neededKeys.add("sales_discounts");
  if (isWalkIn) for (const p of paymentLines) neededKeys.add(METHOD_KEY[p.method]);
  const mappings = await resolveMany(trx, ctx.tenantId, [...neededKeys]);

  const glLines: Parameters<typeof postEntry>[2]["lines"] = [];
  if (isWalkIn) {
    const byMethod = new Map<string, Decimal>();
    for (const p of paymentLines) {
      byMethod.set(p.method, (byMethod.get(p.method) ?? new Decimal(0)).plus(dec(p.amount)));
    }
    for (const [method, amt] of byMethod) {
      glLines.push({ accountId: mappings[METHOD_KEY[method]], debit: toDb(roundMoney(amt)), credit: "0" });
    }
  } else {
    glLines.push({ accountId: mappings.ar_control, debit: toDb(total), credit: "0" });
  }
  if (gross.gt(0)) glLines.push({ accountId: mappings.sales, debit: "0", credit: toDb(gross) });
  if (disc.gt(0)) glLines.push({ accountId: mappings.sales_discounts!, debit: toDb(disc), credit: "0" });
  if (vat.gt(0)) glLines.push({ accountId: mappings.output_vat, debit: "0", credit: toDb(vat) });
  if (cogsNormal.gt(0)) glLines.push({ accountId: mappings.cogs, debit: toDb(cogsNormal), credit: "0" });
  if (cogsFree.gt(0)) glLines.push({ accountId: mappings.free_goods_expense!, debit: toDb(cogsFree), credit: "0" });
  const invCostTotal = cogsNormal.plus(cogsFree);
  if (invCostTotal.gt(0)) {
    glLines.push({ accountId: mappings.inventory_control, debit: "0", credit: toDb(invCostTotal) });
  }

  await postEntry(
    trx,
    ctx,
    {
      sourceType: "sales_invoice",
      sourceId: invoiceId,
      effectKind: "post",
      businessDate: inv.businessDate,
      memo: `فاتورة بيع ${invoiceNo}`,
      lines: glLines,
    },
    "SAR",
  );

  // -------- e-invoice issuance (IZ §2/§5): when tax is enabled with complete
  // seller config this creates the submission atomically; incomplete config
  // raises a blocking ConfigurationError here (INV-17) — never silent.
  {
    const { createSubmissionForInvoice } = await import("@/modules/tax/submissions");
    await createSubmissionForInvoice(trx, ctx, invoiceId);
  }

  // -------- payment receipt settles the AR in the same transaction (P-07)
  if (paymentLines.length > 0 && inv.customerId) {
    await createReceiptCore(trx, ctx, {
      customerId: inv.customerId,
      businessDate: inv.businessDate,
      paymentLines,
      allocations: [{ invoiceId, amount: toDb(Decimal.min(paidNow, total)) }],
      memo: `تحصيل فاتورة ${invoiceNo}`,
    });
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "sales.invoice.posted",
    entity: "sales_invoice",
    entityId: invoiceId,
    after: { invoiceNo, total: toDb(total), cogs: toDb(invCostTotal) },
  });
  return { invoiceNo, replayed: false };
}

/** POS Action A: create + post atomically (draft→posted inside one tx). */
export async function createAndPostInvoice(
  trx: Trx,
  ctx: ServiceCtx,
  input: SaleInvoiceInput,
  canPriceOverride: boolean,
): Promise<{ invoiceId: string; invoiceNo: number; replayed: boolean }> {
  if (input.clientOpId) {
    const [dup] = await trx
      .select({ id: salesInvoices.id, invoiceNo: salesInvoices.invoiceNo, businessStatus: salesInvoices.businessStatus })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.clientOpId, input.clientOpId)))
      .limit(1);
    if (dup && dup.businessStatus === "posted") {
      return { invoiceId: dup.id, invoiceNo: dup.invoiceNo!, replayed: true };
    }
  }
  const id = await createInvoiceDraft(trx, ctx, input, canPriceOverride);
  const posted = await postInvoice(trx, ctx, id, { paymentLines: input.paymentLines });
  return { invoiceId: id, ...posted };
}

/**
 * Return document (P-05): validated against original sold-minus-returned,
 * stock back at original COGS, credit note against customer balance.
 */
export async function createReturn(
  trx: Trx,
  ctx: ServiceCtx,
  originalInvoiceId: string,
  perLineQty: Record<string, string>, // originalLineId → qtyBase
  businessDate: string,
): Promise<{ invoiceId: string; invoiceNo: number }> {
  const [orig] = await trx
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, originalInvoiceId)))
    .for("update")
    .limit(1);
  if (!orig) throw errors.notFound("salesInvoice", originalInvoiceId);
  if (orig.businessStatus !== "posted" || orig.invoiceType !== "sale") {
    throw errors.validation("errors.returnOnlyPostedSale");
  }
  const origLines = await trx
    .select()
    .from(salesInvoiceLines)
    .where(eq(salesInvoiceLines.invoiceId, originalInvoiceId));

  // already returned per original line (from all return docs of this invoice)
  const returnedRows = await trx.execute(sql`
    select rl.original_line_id, coalesce(sum(rl.qty_base),0)::text as returned
    from sales_invoice_lines rl
    join sales_invoices ri on ri.id = rl.invoice_id
    where ri.tenant_id = ${ctx.tenantId} and ri.original_invoice_id = ${originalInvoiceId}
      and ri.business_status = 'posted'
    group by rl.original_line_id
  `);
  const returned = new Map(
    (returnedRows as unknown as { rows: { original_line_id: string; returned: string }[] }).rows.map((r) => [r.original_line_id, dec(r.returned)]),
  );

  const retLines: { orig: (typeof origLines)[number]; qty: Decimal }[] = [];
  for (const l of origLines) {
    const want = dec(perLineQty[l.id] ?? "0");
    if (want.lte(0)) continue;
    const already = returned.get(l.id) ?? new Decimal(0);
    const remaining = dec(l.qtyBase).minus(already);
    if (want.gt(remaining)) {
      throw errors.validation("errors.returnExceedsSold", l.id, {
        remaining: remaining.toFixed(6),
        requested: want.toFixed(6),
      });
    }
    retLines.push({ orig: l, qty: want });
  }
  if (retLines.length === 0) throw errors.validation("errors.returnEmpty");

  // build return document
  const id = newId();
  const computed = retLines.map(({ orig, qty }) => {
    const unitNet = dec(orig.netAmount).div(dec(orig.qtyBase));
    const net = roundMoney(unitNet.times(qty));
    const vat = roundMoney(net.times(dec(orig.vatRate)));
    const unitCogs = dec(orig.lineCogs ?? "0").div(dec(orig.qtyBase));
    return { orig, qty, net, vat, unitCogs, unitPrice: dec(orig.unitPrice) };
  });
  const netSum = roundMoney(sum(computed.map((c) => toDb(c.net))));
  const vatSum = roundMoney(sum(computed.map((c) => toDb(c.vat))));

  await trx.insert(salesInvoices).values({
    id,
    tenantId: ctx.tenantId,
    invoiceType: "sale_return",
    originalInvoiceId,
    customerId: orig.customerId,
    warehouseId: orig.warehouseId,
    businessDate,
    isCredit: orig.isCredit,
    dueDate: null,
    subtotal: toDb(netSum),
    discountTotal: "0",
    vatTotal: toDb(vatSum),
    total: netSum.plus(vatSum).toFixed(2),
    salespersonUserId: ctx.actorId,
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
  await trx.insert(salesInvoiceLines).values(
    computed.map((c, i) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      invoiceId: id,
      lineNo: i + 1,
      lineKind: "return_line" as const,
      productId: c.orig.productId,
      originalLineId: c.orig.id,
      qtyBase: toDb(c.qty),
      unitPrice: toDb(c.unitPrice),
      netAmount: toDb(c.net),
      vatRate: toDb(dec(c.orig.vatRate)),
      vatAmount: toDb(c.vat),
      totalAmount: toDb(c.net.plus(c.vat)),
      lineCogs: toDb(c.unitCogs.times(c.qty)),
    })),
  );

  // stock back in at original COGS (P-05)
  for (const c of computed) {
    const inCost = c.unitCogs;
    if (inCost.lte(0)) {
      throw errors.configuration("errors.zeroCostBlocked", "return without captured cost");
    }
    await recordMovement(trx, ctx, {
      warehouseId: orig.warehouseId,
      productId: c.orig.productId,
      qty: toDb(c.qty),
      movementType: "return_in",
      unitCost: inCost.toFixed(4),
      businessDate,
      sourceType: "sales_return",
      sourceId: id,
      effectKind: "return_in",
      lineRef: c.orig.id,
      memo: "مردود مبيعات",
    });
  }

  const invoiceNo = await nextDocNumber(trx, ctx.tenantId, "CN");
  const [posted] = await trx
    .update(salesInvoices)
    .set({
      businessStatus: "posted",
      inventoryStatus: "issued",
      accountingStatus: "posted",
      invoiceNo,
      postedAt: new Date(),
      postedBy: ctx.actorId,
    })
    .where(and(eq(salesInvoices.id, id), eq(salesInvoices.businessStatus, "draft")))
    .returning({ id: salesInvoices.id });
  if (!posted) throw errors.invariant("return post race", { id });

  const mappings = await resolveMany(trx, ctx.tenantId, ["sales_returns", "output_vat", "ar_control", "inventory_control", "cogs"]);
  const cogsBack = roundMoney(sum(computed.map((c) => toDb(c.unitCogs.times(c.qty)))));
  const total = netSum.plus(vatSum);
  await postEntry(
    trx,
    ctx,
    {
      sourceType: "sales_return",
      sourceId: id,
      effectKind: "post",
      businessDate,
      memo: `إشعار دائن ${invoiceNo} (مردود ${orig.invoiceNo ?? ""})`,
      lines: [
        { accountId: mappings.sales_returns, debit: toDb(netSum), credit: "0" },
        ...(vatSum.gt(0) ? [{ accountId: mappings.output_vat, debit: toDb(vatSum), credit: "0" }] : []),
        { accountId: mappings.ar_control, debit: "0", credit: toDb(total) },
        { accountId: mappings.inventory_control, debit: toDb(cogsBack), credit: "0" },
        { accountId: mappings.cogs, debit: "0", credit: toDb(cogsBack) },
      ],
    },
    "SAR",
  );

  // credit note issuance parallels the invoice (IZ §6 — referenced original)
  {
    const { createSubmissionForInvoice } = await import("@/modules/tax/submissions");
    await createSubmissionForInvoice(trx, ctx, id);
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "sales.return.posted",
    entity: "sales_invoice",
    entityId: id,
    after: { invoiceNo, original: originalInvoiceId, total: toDb(total) },
  });
  return { invoiceId: id, invoiceNo };
}

export { invoiceOutstanding } from "./balances";
export { isDomainError };
