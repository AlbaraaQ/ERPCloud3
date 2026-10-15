/**
 * Purchases (FR-039/040): supplier invoices post stock + GL atomically,
 * payments allocate to open purchase invoices (AP mirror of AR).
 */

import { and, eq, sql } from "drizzle-orm";
import {
  suppliers,
  products,
  purchaseInvoices,
  purchaseInvoiceLines,
  supplierPayments,
  supplierAllocations,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { Decimal, dec, roundMoney, toDb, sum } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { recordMovement } from "@/modules/inventory/stock";
import { postEntry, nextDocNumber, type PostingLine } from "@/modules/accounting/posting";
import { resolveMany, resolveMappingId } from "@/modules/accounting/mappings";
import { vatRateFor } from "@/modules/sales/pricing";

export interface PurchaseLineInput {
  productId: string;
  qtyBase: string;
  unitCost: string;
  batchNo?: string | null;
  expiryDate?: string | null;
}

export interface PurchaseInvoiceInput {
  supplierId: string;
  supplierRef?: string | null;
  warehouseId: string;
  businessDate: string;
  dueDate?: string | null;
  lines: PurchaseLineInput[];
}

export async function createPurchaseDraft(
  trx: Trx,
  ctx: ServiceCtx,
  input: PurchaseInvoiceInput,
): Promise<string> {
  if (input.lines.length === 0) throw errors.validation("errors.invoiceEmpty");
  let net = new Decimal(0);
  let vat = new Decimal(0);
  const computed: {
    line: PurchaseLineInput;
    net: Decimal;
    vat: Decimal;
    vatRate: Decimal;
  }[] = [];
  for (const [i, l] of input.lines.entries()) {
    const qty = dec(l.qtyBase);
    const cost = dec(l.unitCost);
    if (qty.lte(0)) throw errors.validation("errors.qtyMustBePositive", undefined, { line: i + 1 });
    if (cost.lte(0)) throw errors.configuration("errors.zeroCostBlocked", undefined, { line: i + 1 });
    const [p] = await trx
      .select({ id: products.id, taxCategory: products.taxCategory, active: products.active })
      .from(products)
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, l.productId)))
      .limit(1);
    if (!p || !p.active) throw errors.validation("errors.productInvalid", l.productId, { line: i + 1 });
    const lineNet = roundMoney(qty.times(cost));
    const rate = dec(vatRateFor(p.taxCategory));
    const lineVat = roundMoney(lineNet.times(rate));
    net = net.plus(lineNet);
    vat = vat.plus(lineVat);
    computed.push({ line: l, net: lineNet, vat: lineVat, vatRate: rate });
  }

  const id = newId();
  await trx.insert(purchaseInvoices).values({
    id,
    tenantId: ctx.tenantId,
    supplierId: input.supplierId,
    supplierRef: input.supplierRef ?? null,
    warehouseId: input.warehouseId,
    businessDate: input.businessDate,
    dueDate: input.dueDate ?? null,
    status: "draft",
    subtotal: toDb(roundMoney(net)),
    vatTotal: toDb(roundMoney(vat)),
    total: toDb(roundMoney(net.plus(vat))),
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
  await trx.insert(purchaseInvoiceLines).values(
    computed.map((c, i) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      invoiceId: id,
      lineNo: i + 1,
      productId: c.line.productId,
      qtyBase: toDb(dec(c.line.qtyBase)),
      unitCost: toDb(dec(c.line.unitCost)),
      netAmount: toDb(c.net),
      vatRate: toDb(c.vatRate),
      vatAmount: toDb(c.vat),
      batchNo: c.line.batchNo ?? null,
      expiryDate: c.line.expiryDate ?? null,
    })),
  );
  return id;
}

/** Post a purchase invoice: stock receive + GL (P-09) atomically. */
export async function postPurchaseInvoice(
  trx: Trx,
  ctx: ServiceCtx,
  invoiceId: string,
): Promise<{ invoiceNo: number; replayed: true } | { invoiceNo: number; replayed: false }> {
  const [inv] = await trx
    .select()
    .from(purchaseInvoices)
    .where(and(eq(purchaseInvoices.tenantId, ctx.tenantId), eq(purchaseInvoices.id, invoiceId)))
    .for("update")
    .limit(1);
  if (!inv) throw errors.notFound("purchaseInvoice", invoiceId);
  if (inv.status === "posted") return { invoiceNo: inv.invoiceNo!, replayed: true };

  const lines = await trx
    .select()
    .from(purchaseInvoiceLines)
    .where(eq(purchaseInvoiceLines.invoiceId, invoiceId));
  if (lines.length === 0) throw errors.validation("errors.invoiceEmpty");

  for (const l of lines) {
    await recordMovement(trx, ctx, {
      warehouseId: inv.warehouseId,
      productId: l.productId,
      qty: l.qtyBase,
      movementType: "receive",
      unitCost: l.unitCost,
      lot: l.batchNo ? { batchNo: l.batchNo, expiryDate: l.expiryDate } : undefined,
      businessDate: inv.businessDate,
      sourceType: "purchase_invoice",
      sourceId: invoiceId,
      effectKind: "purchase_receive",
      lineRef: l.id,
      memo: "استلام مشتريات",
    });
  }

  const invoiceNo = await nextDocNumber(trx, ctx.tenantId, "PI");
  const [posted] = await trx
    .update(purchaseInvoices)
    .set({ status: "posted", invoiceNo, postedAt: new Date() })
    .where(and(eq(purchaseInvoices.id, invoiceId), eq(purchaseInvoices.status, "draft")))
    .returning({ id: purchaseInvoices.id });
  if (!posted) return { invoiceNo, replayed: true };

  const mappings = await resolveMany(trx, ctx.tenantId, ["inventory_control", "input_vat", "ap_control"]);
  const net = dec(inv.subtotal);
  const vat = dec(inv.vatTotal);
  await postEntry(
    trx,
    ctx,
    {
      sourceType: "purchase_invoice",
      sourceId: invoiceId,
      effectKind: "post",
      businessDate: inv.businessDate,
      memo: `فاتورة شراء ${invoiceNo}${inv.supplierRef ? ` (${inv.supplierRef})` : ""}`,
      lines: [
        { accountId: mappings.inventory_control, debit: toDb(net), credit: "0" },
        ...(vat.gt(0) ? [{ accountId: mappings.input_vat, debit: toDb(vat), credit: "0" }] : []),
        { accountId: mappings.ap_control, debit: "0", credit: toDb(dec(inv.total)) },
      ],
    },
    "SAR",
  );

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "purchasing.invoice.posted",
    entity: "purchase_invoice",
    entityId: invoiceId,
    after: { invoiceNo, total: inv.total },
  });
  return { invoiceNo, replayed: false };
}

/** Outstanding per posted purchase invoice. */
export async function purchaseOutstanding(trx: Trx, tenantId: string, invoiceId: string): Promise<Decimal> {
  const res = await trx.execute(sql`
    select (i.total - coalesce((select sum(a.amount) from supplier_allocations a
        where a.tenant_id = i.tenant_id and a.purchase_invoice_id = i.id), 0))::text as outstanding
    from purchase_invoices i
    where i.tenant_id = ${tenantId} and i.id = ${invoiceId}
  `);
  const row = (res as unknown as { rows: { outstanding: string }[] }).rows[0];
  return dec(row?.outstanding ?? "0");
}

/** Supplier payment + allocations (P-11; INV-09 mirror for AP). */
export async function createSupplierPayment(
  trx: Trx,
  ctx: ServiceCtx,
  input: {
    supplierId: string;
    businessDate: string;
    method: "cash" | "bank_transfer" | "card" | "other";
    treasuryAccountId: string;
    amount: string;
    allocations: { purchaseInvoiceId: string; amount: string }[];
    memo?: string | null;
  },
): Promise<{ paymentId: string; paymentNo: number }> {
  const [supplier] = await trx
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.id, input.supplierId)))
    .limit(1);
  if (!supplier) throw errors.notFound("supplier", input.supplierId);

  const amount = roundMoney(input.amount);
  if (amount.lte(0)) throw errors.validation("errors.receiptZeroTotal");
  const allocTotal = roundMoney(sum(input.allocations.map((a) => a.amount)));
  if (allocTotal.gt(amount)) {
    throw errors.validation("errors.allocExceedsReceipt");
  }

  for (const a of input.allocations) {
    const amt = roundMoney(a.amount);
    if (amt.lte(0)) throw errors.validation("errors.qtyMustBePositive");
    await trx
      .select({ id: purchaseInvoices.id })
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.tenantId, ctx.tenantId), eq(purchaseInvoices.id, a.purchaseInvoiceId)))
      .for("update");
    const outstanding = await purchaseOutstanding(trx, ctx.tenantId, a.purchaseInvoiceId);
    if (amt.gt(outstanding)) {
      throw errors.validation("errors.allocExceedsOutstanding", undefined, {
        invoiceId: a.purchaseInvoiceId,
        outstanding: outstanding.toFixed(2),
        amount: amt.toFixed(2),
      });
    }
  }

  const paymentNo = await nextDocNumber(trx, ctx.tenantId, "PV");
  const id = newId();
  await trx.insert(supplierPayments).values({
    id,
    tenantId: ctx.tenantId,
    paymentNo,
    supplierId: input.supplierId,
    businessDate: input.businessDate,
    method: input.method,
    treasuryAccountId: input.treasuryAccountId,
    amount: toDb(amount),
    allocatedAmount: toDb(allocTotal),
    memo: input.memo ?? null,
    status: "posted",
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
  if (input.allocations.length > 0) {
    await trx.insert(supplierAllocations).values(
      input.allocations.map((a) => ({
        id: newId(),
        tenantId: ctx.tenantId,
        paymentId: id,
        purchaseInvoiceId: a.purchaseInvoiceId,
        amount: toDb(roundMoney(a.amount)),
        createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
      })),
    );
  }

  const glKey = input.method === "cash" ? "cash_default" : "bank_default";
  const ap = await resolveMappingId(trx, ctx.tenantId, "ap_control");
  const gl = await resolveMappingId(trx, ctx.tenantId, glKey);
  const advance = amount.minus(allocTotal);
  const lines: PostingLine[] = [
    { accountId: gl, debit: "0", credit: toDb(amount) },
  ];
  if (allocTotal.gt(0)) lines.push({ accountId: ap, debit: toDb(allocTotal), credit: "0" });
  if (advance.gt(0)) {
    const supAdv = await resolveMappingId(trx, ctx.tenantId, "supplier_advances");
    lines.push({ accountId: supAdv, debit: toDb(advance), credit: "0" });
  }
  await postEntry(
    trx,
    ctx,
    {
      sourceType: "supplier_payment",
      sourceId: id,
      effectKind: "post",
      businessDate: input.businessDate,
      memo: `سند صرف مورد ${paymentNo}`,
      lines,
    },
    "SAR",
  );

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "purchasing.payment.posted",
    entity: "supplier_payment",
    entityId: id,
    after: { paymentNo, amount: toDb(amount), allocated: toDb(allocTotal) },
  });
  return { paymentId: id, paymentNo };
}

/** AP exposure per supplier. */
export async function supplierExposure(trx: Trx, tenantId: string, supplierId: string): Promise<Decimal> {
  const res = await trx.execute(sql`
    select (
      coalesce((select sum(total) from purchase_invoices
        where tenant_id = ${tenantId} and supplier_id = ${supplierId} and status='posted'), 0)
      - coalesce((select sum(a.amount) from supplier_allocations a
        join purchase_invoices i on i.id = a.purchase_invoice_id
        where a.tenant_id = ${tenantId} and i.supplier_id = ${supplierId}), 0)
    )::text as exposure
  `);
  const row = (res as unknown as { rows: { exposure: string }[] }).rows[0];
  return dec(row.exposure);
}
