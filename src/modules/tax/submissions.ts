/**
 * E-invoice submission engine (IZ §3-7, D-012/D-024).
 *
 * - Issuance (uuid + ICV + PIH chain) happens atomically inside the posting
 *   transaction; retries NEVER re-issue — same uuid/ICV/XML every attempt
 *   (INV-02).
 * - Documents are signed with the EGS key pair + CSID certificate issued by
 *   ZATCA (compliance during onboarding, production afterwards). Without that
 *   material the submission is `blocked_config` — the product never fabricates
 *   a QR, a signature or a clearance status.
 * - Tax encoding per line (S/Z/E/O) uses the tenant's exemption ruling from the
 *   official catalogue; a zero-rated/exempt line without one blocks issuance
 *   instead of silently claiming an exemption (INV-17, BR-KSA-CL-04).
 */

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  invoiceSubmissions,
  salesInvoices,
  salesInvoiceLines,
  allocations,
  receiptLines,
  products,
  units,
  customers,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { dec, toDb } from "@/modules/shared/money";
import {
  getTaxConfig,
  resolveSellerIdentity,
  resolveSigningMaterial,
  classifyInvoice,
} from "./config";
import {
  buildInvoiceXml,
  computeInvoiceHash,
  canonicalizeForHash,
  paymentMeansCodesFor,
  validateInvoiceXml,
  type BuyerIdentity,
  type InvoiceXmlInput,
  type TaxCategoryCode,
  type TaxSubtotalInput,
  type XmlLine,
} from "./xml";
import { resolveExemption, type ExemptionConfig } from "./exemption";

export interface SubmissionCreated {
  submissionId: string;
  docType: "simplified" | "standard";
  status: "issued_pending_reporting" | "clearance_pending" | "blocked_config";
  icv: number;
  invoiceHash: string;
}

/** Product tax category → UBL tax category code. */
function categoryCodeFor(productCategory: string): TaxCategoryCode {
  switch (productCategory) {
    case "standard":
      return "S";
    case "zero":
      return "Z";
    case "exempt":
      return "E";
    case "out_of_scope":
      return "O";
    default:
      throw errors.configuration("errors.taxCategoryUnknown", productCategory);
  }
}

function envNow(): { issueTime: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { issueTime: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` };
}

/**
 * Issue the next chain position atomically: locks the tenant chain row inside
 * the posting transaction (ICV gapless per EGS; PIH links the previous hash).
 */
async function nextChain(
  trx: Trx,
  tenantId: string,
): Promise<{ icv: number; previousHashB64: string }> {
  const chainId = `${tenantId}:main`;
  await trx.execute(sql`
    insert into invoice_chains (id, tenant_id) values (${chainId}, ${tenantId})
    on conflict (id) do nothing
  `);
  const rows = await trx.execute(sql`
    select icv, last_hash from invoice_chains where id = ${chainId} for update
  `);
  const row = (rows as unknown as { rows: { icv: number; last_hash: string }[] }).rows[0];
  return { icv: Number(row.icv) + 1, previousHashB64: row.last_hash };
}

async function markChain(trx: Trx, tenantId: string, icv: number, hashB64: string): Promise<void> {
  const chainId = `${tenantId}:main`;
  await trx.execute(sql`
    update invoice_chains set icv = ${icv}, last_hash = ${hashB64}, updated_at = now()
    where id = ${chainId}
  `);
}

/** Payment paths actually used on the invoice (cash/card/bank) — else credit. */
async function paymentMethodsForInvoice(
  trx: Trx,
  tenantId: string,
  invoiceId: string,
): Promise<string[]> {
  const rows = await trx
    .select({ method: receiptLines.method })
    .from(allocations)
    .innerJoin(receiptLines, eq(receiptLines.receiptId, allocations.receiptId))
    .where(and(eq(allocations.tenantId, tenantId), eq(allocations.invoiceId, invoiceId)));
  return [...new Set(rows.map((r) => r.method))];
}

async function buyerOf(trx: Trx, tenantId: string, customerId: string | null): Promise<BuyerIdentity | null> {
  if (!customerId) return null;
  const [c] = await trx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
    .limit(1);
  if (!c) return null;
  const vat = c.taxNumber && /^3\d{13}3$/.test(c.taxNumber) ? c.taxNumber : null;
  return {
    registrationName: c.nameAr,
    vatNumber: vat,
    identification: vat
      ? { schemeId: "NAT", value: c.taxNumber! }
      : c.crNumber
        ? { schemeId: "CRN", value: c.crNumber }
        : null,
    street: c.address ?? null,
    buildingNo: c.buildingNo ?? null,
    plotIdentification: c.plotIdentification ?? null,
    district: c.district ?? null,
    city: c.city ?? null,
    postalCode: c.postalCode ?? null,
  };
}

/**
 * Create (idempotently) the e-invoice submission for a POSTED invoice.
 * Called from the posting transaction; mirrors `sales_invoices.tax_status`.
 */
export async function createSubmissionForInvoice(
  trx: Trx,
  ctx: ServiceCtx,
  invoiceId: string,
): Promise<SubmissionCreated | null> {
  const cfg = await getTaxConfig(trx, ctx.tenantId);
  if (!cfg?.enabled) return null; // tenant not opted into e-invoicing

  const [inv] = await trx
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, invoiceId)))
    .limit(1);
  if (!inv || inv.businessStatus !== "posted") return null;

  const [existing] = await trx
    .select()
    .from(invoiceSubmissions)
    .where(
      and(eq(invoiceSubmissions.tenantId, ctx.tenantId), eq(invoiceSubmissions.invoiceId, invoiceId)),
    )
    .limit(1);
  if (existing) {
    return {
      submissionId: existing.id,
      docType: existing.docType as SubmissionCreated["docType"],
      status: existing.status as SubmissionCreated["status"],
      icv: existing.icv,
      invoiceHash: existing.invoiceHash,
    };
  }

  const seller = await resolveSellerIdentity(trx, ctx.tenantId); // ConfigurationError when incomplete
  const buyer = await buyerOf(trx, ctx.tenantId, inv.customerId);
  const cls = await classifyInvoice(trx, ctx.tenantId, inv.customerId, inv.invoiceType);

  const lineRows = await trx
    .select({
      lineNo: salesInvoiceLines.lineNo,
      netAmount: salesInvoiceLines.netAmount,
      vatRate: salesInvoiceLines.vatRate,
      vatAmount: salesInvoiceLines.vatAmount,
      unitPrice: salesInvoiceLines.unitPrice,
      qtyBase: salesInvoiceLines.qtyBase,
      discountAmount: salesInvoiceLines.discountAmount,
      lineKind: salesInvoiceLines.lineKind,
      productName: products.nameAr,
      taxCategory: products.taxCategory,
      unitCode: units.code,
    })
    .from(salesInvoiceLines)
    .innerJoin(products, eq(products.id, salesInvoiceLines.productId))
    .leftJoin(units, eq(units.id, products.stockUnitId))
    .where(eq(salesInvoiceLines.invoiceId, invoiceId));

  const exemptionConfig = (cfg.exemptionReasons ?? null) as ExemptionConfig | null;
  const lines: XmlLine[] = [];
  const subtotalMap = new Map<string, TaxSubtotalInput>();

  for (const l of lineRows) {
    const category = categoryCodeFor(l.taxCategory);
    const resolved = resolveExemption(exemptionConfig, category);
    if (!resolved.ok) {
      throw errors.configuration("errors.exemptionReasonMissing", resolved.reason, {
        category,
        productName: l.productName,
      });
    }
    const exemption = resolved.exemption;
    const ratePercent = String(Number(l.vatRate) * 100);

    lines.push({
      lineNo: Number(l.lineNo),
      productName: l.productName,
      qty: l.qtyBase,
      unitCode: /^[A-Z]{2,3}$/.test(l.unitCode ?? "") ? l.unitCode! : "PCE",
      unitPrice: l.unitPrice,
      lineNet: l.netAmount,
      discountAmount: l.discountAmount,
      vatRate: ratePercent,
      vatAmount: l.vatAmount,
      taxCategory: category,
      free: l.lineKind === "free",
    });

    // one breakdown row per (category, rate, exemption reason) — BG-23
    const key = `${category}:${ratePercent}:${exemption?.code ?? ""}`;
    const current = subtotalMap.get(key) ?? {
      category,
      rate: ratePercent,
      taxable: "0",
      tax: "0",
      exemptionReasonCode: exemption?.code ?? null,
      exemptionReason: exemption?.reason ?? null,
      includePercent: exemption?.includePercent ?? true,
    };
    subtotalMap.set(key, {
      ...current,
      taxable: toDb(dec(current.taxable).plus(dec(l.netAmount))),
      tax: toDb(dec(current.tax).plus(dec(l.vatAmount))),
    });
  }

  // Signing material: production CSID for real invoices — a compliance CSID
  // exists only during onboarding and cannot be used for live documents.
  let signing: Awaited<ReturnType<typeof resolveSigningMaterial>> = null;
  try {
    signing = await resolveSigningMaterial(trx, ctx.tenantId, cfg.env, "production");
  } catch {
    signing = null; // certificate/key mismatch → blocked_config, never a fake signature
  }

  const invoiceUuid = randomUUID();
  const { issueTime } = envNow();
  const paymentMethods = await paymentMethodsForInvoice(trx, ctx.tenantId, invoiceId);
  const instructionNote =
    inv.taxNote ?? (cls.docSubtype === "credit_note" ? "Returned items" : null);

  const xmlInput: InvoiceXmlInput = {
    invoiceNumber: String(inv.invoiceNo ?? inv.id.slice(0, 8)),
    uuid: invoiceUuid,
    icv: 0, // filled after the chain lock
    previousHashB64: "",
    issueDate: inv.businessDate,
    issueTime,
    docType: cls.docType,
    docSubtype: cls.docSubtype,
    transactionFlags: {},
    currency: "SAR",
    seller,
    buyer,
    deliveryDate: inv.businessDate,
    paymentMeansCodes: paymentMeansCodesFor(paymentMethods),
    instructionNote,
    netTotal: inv.subtotal,
    discountTotal: inv.discountTotal,
    vatTotal: inv.vatTotal,
    totalWithVat: inv.total,
    prepaidTotal: Number(inv.paidTotal) > 0 ? inv.paidTotal : undefined,
    taxSubtotals: [...subtotalMap.values()],
    lines,
    billingReference: inv.originalInvoiceId
      ? await originalReference(trx, ctx.tenantId, inv.originalInvoiceId)
      : null,
    signature: signing
      ? {
          certificateB64Der: signing.certificateB64Der,
          privateKeyPem: signing.privateKeyPem,
          signingTimeIso: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        }
      : null,
  };

  // 1. chain issuance under the tenant row lock (gapless ICV, PIH link)
  const chain = await nextChain(trx, ctx.tenantId);
  xmlInput.icv = chain.icv;
  xmlInput.previousHashB64 = chain.previousHashB64;

  // 2. render (and sign, when the EGS material exists)
  const xml = buildInvoiceXml(xmlInput);
  const hash = computeInvoiceHash(xml);

  // 3. local pre-flight — mirror of the KSA rule families we can evaluate
  const issues = validateInvoiceXml(xml, xmlInput);
  const blocking = issues.filter((i) => i.severity === "error");
  await markChain(trx, ctx.tenantId, chain.icv, hash.b64);

  const hasSignature = Boolean(signing);
  const status: SubmissionCreated["status"] = !hasSignature
    ? "blocked_config"
    : blocking.length > 0
      ? "blocked_config"
      : cls.docType === "simplified"
        ? "issued_pending_reporting"
        : "clearance_pending";

  const qr = extractQr(xml);
  const signatureValue = /<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/.exec(xml)?.[1] ?? null;

  const id = (
    await trx
      .insert(invoiceSubmissions)
      .values({
        tenantId: ctx.tenantId,
        invoiceId,
        invoiceUuid,
        icv: chain.icv,
        docType: cls.docType,
        docSubtype: cls.docSubtype,
        previousHash: chain.previousHashB64,
        invoiceHash: hash.b64,
        xml,
        qrBase64: qr,
        signatureValue,
        status,
        lastErrorClass: blocking.length > 0 ? "validation" : hasSignature ? null : "config",
        lastError: blocking.length > 0
          ? blocking.map((i) => `${i.code}:${i.field}`).join(",")
          : hasSignature
            ? null
            : "production_credential_missing",
      })
      .returning({ id: invoiceSubmissions.id })
  )[0];

  await trx
    .update(salesInvoices)
    .set({
      taxStatus:
        status === "blocked_config"
          ? "local_draft"
          : status === "issued_pending_reporting"
            ? "issued_pending_reporting"
            : "clearance_pending",
    })
    .where(eq(salesInvoices.id, invoiceId));

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "tax.submission.created",
    entity: "invoice_submission",
    entityId: id.id,
    after: {
      docType: cls.docType,
      icv: chain.icv,
      status,
      invoiceUuid,
      hashPrefix: hash.b64.slice(0, 12),
      signed: hasSignature,
      preflight: issues.map((i) => i.code),
    },
  });

  return {
    submissionId: id.id,
    docType: cls.docType,
    status,
    icv: chain.icv,
    invoiceHash: hash.b64,
  };
}

async function originalReference(
  trx: Trx,
  tenantId: string,
  originalInvoiceId: string,
): Promise<{ invoiceNumber: string; uuid: string | null } | null> {
  const [orig] = await trx
    .select({ invoiceNo: salesInvoices.invoiceNo })
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, originalInvoiceId)))
    .limit(1);
  if (!orig) return null;
  const [sub] = await trx
    .select({ uuid: invoiceSubmissions.invoiceUuid })
    .from(invoiceSubmissions)
    .where(
      and(
        eq(invoiceSubmissions.tenantId, tenantId),
        eq(invoiceSubmissions.invoiceId, originalInvoiceId),
      ),
    )
    .limit(1);
  return {
    invoiceNumber: String(orig.invoiceNo ?? originalInvoiceId.slice(0, 8)),
    uuid: sub?.uuid ?? null,
  };
}

export function extractQr(xml: string): string | null {
  const m =
    /<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(
      xml,
    );
  return m?.[1]?.trim() ?? null;
}

/**
 * Canonical form of the invoice used for hashing (UBLExtensions, cac:Signature
 * and the QR reference removed). The transport boundary re-validates the hash of
 * what it is about to submit against this form.
 */
export function normalizeXmlForHash(xml: string): string {
  return canonicalizeForHash(xml).c14n;
}
