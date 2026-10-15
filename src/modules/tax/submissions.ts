/**
 * E-invoice submission engine (IZ §3-7, D-012/D-024).
 * - Issuance (uuid v4 + ICV + PIH chain) atomically inside the posting tx:
 *   retries NEVER re-issue — same uuid/ICV/XML on every attempt (INV-02).
 * - Device keys sign the invoice hash (secp256k1); unsigned submissions are
 *   blocked_config — never fabricated QR/signature/clearance.
 * - Transport is a boundary: HttpTransport implements the officially
 *   documented endpoints; MockTransport exists ONLY for tests/dev-gate.
 */

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  zatcaCertificates,
  invoiceSubmissions,
  salesInvoices,
  salesInvoiceLines,
  products,
  customers,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { dec, roundMoney, toDb } from "@/modules/shared/money";
import { logger } from "@/modules/shared/logger";
import {
  getTaxConfig, resolveSellerIdentity, classifyInvoice, paymentMeansCodeFor,
} from "./config";
import {
  buildInvoiceXml, computeInvoiceHash, qrTimestamp, type InvoiceXmlInput,
} from "./xml";
import { simplifiedQrPayload, standardQrPayload, signHash, publicKeyRawFromPem, initialPih, b64 } from "./crypto";

export interface SubmissionCreated {
  submissionId: string;
  docType: "simplified" | "standard";
  status: "issued_pending_reporting" | "clearance_pending" | "blocked_config";
  icv: number;
}

function envNowForInvoice(businessDate: string): { issueTime: string; offset: string } {
  return {
    issueTime: `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}:${String(new Date().getSeconds()).padStart(2, "0")}`,
    offset: "+03:00",
  };
}

/**
 * Issue chain state atomically: locks the tenant chain row inside the posting
 * transaction (ICV gapless per EGS; PIH links previous hash).
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
  return { icv: Number(row.icv) + 1, previousHashB64: row.last_hash || initialPih() };
}

async function markChain(trx: Trx, tenantId: string, icv: number, hashB64: string): Promise<void> {
  const chainId = `${tenantId}:main`;
  await trx.execute(sql`
    update invoice_chains set icv = ${icv}, last_hash = ${hashB64}, updated_at = now()
    where id = ${chainId}
  `);
}

/**
 * Create (idempotently) the e-invoice submission for a POSTED invoice.
 * Called from the posting transaction; mirrors invoice.tax_status.
 * Idempotent by unique (invoice_id) — replays return the same submission.
 */
export async function createSubmissionForInvoice(
  trx: Trx,
  ctx: ServiceCtx,
  invoiceId: string,
): Promise<SubmissionCreated | null> {
  const cfg = await getTaxConfig(trx, ctx.tenantId);
  if (!cfg?.enabled) return null; // tenant not opted into Phase-2 flow → not_applicable

  const [inv] = await trx
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, invoiceId)))
    .limit(1);
  if (!inv || inv.businessStatus !== "posted") return null;

  const [existing] = await trx
    .select()
    .from(invoiceSubmissions)
    .where(and(eq(invoiceSubmissions.tenantId, ctx.tenantId), eq(invoiceSubmissions.invoiceId, invoiceId)))
    .limit(1);
  if (existing) {
    return {
      submissionId: existing.id,
      docType: existing.docType as SubmissionCreated["docType"],
      status: existing.status as SubmissionCreated["status"],
      icv: existing.icv,
    };
  }

  const seller = await resolveSellerIdentity(trx, ctx.tenantId); // ConfigurationError when incomplete
  const cls = await classifyInvoice(trx, ctx.tenantId, inv.customerId, inv.invoiceType);

  // buyer identity for standard invoices
  let buyer: { registrationName: string | null; vatNumber: string | null } | null = null;
  if (inv.customerId) {
    const [c] = await trx
      .select({ nameAr: customers.nameAr, taxNumber: customers.taxNumber })
      .from(customers)
      .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.id, inv.customerId)))
      .limit(1);
    if (c) buyer = { registrationName: c.nameAr, vatNumber: c.taxNumber };
  }

  const lines = await trx
    .select({ netAmount: salesInvoiceLines.netAmount, vatRate: salesInvoiceLines.vatRate, vatAmount: salesInvoiceLines.vatAmount, unitPrice: salesInvoiceLines.unitPrice, qtyBase: salesInvoiceLines.qtyBase, discountAmount: salesInvoiceLines.discountAmount, lineKind: salesInvoiceLines.lineKind, productName: products.nameAr, lineNo: salesInvoiceLines.lineNo })
    .from(salesInvoiceLines)
    .innerJoin(products, eq(products.id, salesInvoiceLines.productId))
    .where(eq(salesInvoiceLines.invoiceId, invoiceId));

  // device key: required to sign (never fabricate)
  const [deviceKey] = await trx
    .select()
    .from(zatcaCertificates)
    .where(
      and(
        eq(zatcaCertificates.tenantId, ctx.tenantId),
        eq(zatcaCertificates.env, cfg.env),
        eq(zatcaCertificates.kind, "device_key"),
        eq(zatcaCertificates.status, "active"),
      ),
    )
    .limit(1);

  const invoiceUuid = randomUUID();
  const { issueTime, offset } = envNowForInvoice(inv.businessDate);

  // 1. build XML (unsigned initially, QR/signature only once key exists)
  const xmlInput: InvoiceXmlInput = {
    invoiceNumber: String(inv.invoiceNo ?? inv.id.slice(0, 8)),
    uuid: invoiceUuid,
    icv: 0, // placeholder, replaced below
    previousHashB64: "PLACEHOLDER",
    issueDate: inv.businessDate,
    issueTime,
    timezoneOffset: offset,
    docType: cls.docType,
    docSubtype: cls.docSubtype,
    currency: "SAR",
    seller,
    buyer,
    paymentMeansCode: paymentMeansCodeFor([]),
    netTotal: inv.subtotal,
    vatTotal: inv.vatTotal,
    totalWithVat: inv.total,
    discountTotal: inv.discountTotal,
    lines: lines.map((l) => ({
      lineNo: Number(l.lineNo),
      productName: l.productName,
      qty: l.qtyBase,
      unitPrice: l.unitPrice,
      lineNet: l.netAmount,
      vatRate: String(Number(l.vatRate) * 100),
      vatAmount: l.vatAmount,
      discountAmount: l.discountAmount,
      free: l.lineKind === "free",
    })),
    signature: null,
  };

  let xml = buildInvoiceXml(xmlInput);
  let hash = computeInvoiceHash(xml);

  // 2. chain issuance under row lock
  const chain = await nextChain(trx, ctx.tenantId);
  const icv = chain.icv;
  xmlInput.icv = icv;
  xmlInput.previousHashB64 = chain.previousHashB64;
  xml = buildInvoiceXml(xmlInput);
  hash = computeInvoiceHash(xml); // recompute with actual ICV/PIH in place

  // 3. device signature + QR (only with real key material)
  let signatureValueB64: string | null = null;
  let qrB64: string | null = null;
  const timestampIso = qrTimestamp(inv.businessDate, issueTime, offset);
  if (deviceKey?.privateKey && deviceKey.publicKey) {
    const sig = signHash(deviceKey.privateKey, Buffer.from(normalizeXmlForHash(xml), "utf8"));
    signatureValueB64 = b64(sig);
    const hashSig = signHash(deviceKey.privateKey, Buffer.from(hash.hex, "utf8"));
    const pubRaw = publicKeyRawFromPem(deviceKey.publicKey);
    // QR money fields formatted to 2 minor units (SDK examples convention)
    qrB64 =
      cls.docType === "simplified"
        ? simplifiedQrPayload({
            sellerName: seller.registrationName,
            vatNumber: seller.vatNumber,
            timestampIso,
            totalWithVat: dec(inv.total).toFixed(2),
            vatTotal: dec(inv.vatTotal).toFixed(2),
            invoiceHashB64: hash.b64,
            signatureValueB64,
            publicKeyRaw: pubRaw,
            hashSignatureB64: b64(hashSig),
          })
        : standardQrPayload({
            sellerName: seller.registrationName,
            vatNumber: seller.vatNumber,
            timestampIso,
            totalWithVat: dec(inv.total).toFixed(2),
            vatTotal: dec(inv.vatTotal).toFixed(2),
          });
    xmlInput.signature = { valueB64: signatureValueB64, qrB64 };
    xml = buildInvoiceXml(xmlInput);
    hash = computeInvoiceHash(xml);
  }

  await markChain(trx, ctx.tenantId, icv, hash.b64);

  const hasSignature = Boolean(signatureValueB64 && qrB64);
  const status: SubmissionCreated["status"] = !hasSignature
    ? "blocked_config"
    : cls.docType === "simplified"
      ? "issued_pending_reporting"
      : "clearance_pending";

  const id = (
    await trx
      .insert(invoiceSubmissions)
      .values({
        tenantId: ctx.tenantId,
        invoiceId,
        invoiceUuid,
        icv,
        docType: cls.docType,
        docSubtype: cls.docSubtype,
        previousHash: chain.previousHashB64,
        invoiceHash: hash.b64,
        xml,
        qrBase64: qrB64,
        signatureValue: signatureValueB64,
        status,
      })
      .returning({ id: invoiceSubmissions.id })
  )[0];

  // invoice.tax_status mirrors submission state (orthogonal dimension, IZ §3)
  await trx
    .update(salesInvoices)
    .set({
      taxStatus:
        status === "blocked_config"
          ? "local_draft" // actionable: configure signing credentials
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
    after: { docType: cls.docType, icv, status, invoiceUuid, hashPrefix: hash.b64.slice(0, 12) },
  });

  return { submissionId: id.id, docType: cls.docType, status, icv };
}

/** Normalization step shared with computeInvoiceHash (kept in one place). */
export function normalizeXmlForHash(xml: string): string {
  return xml
    .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/g, "")
    .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/g, "")
    .replace(/<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/>\s+</g, "><")
    .trim();
}
