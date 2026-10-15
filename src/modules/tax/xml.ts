/**
 * UBL 2.1 / KSA e-invoice document builder.
 *
 * Element order, tax encoding and address layout mirror the official SDK sample
 * documents (Data/Samples/Standard/Invoice/Standard_Invoice.xml and its credit
 * note / zero-rate / exempt / out-of-scope siblings) so the produced document
 * satisfies the KSA business rules (Data/Rules/schematrons/20210819_…):
 *
 *   BR-KSA-15  Delivery/ActualDeliveryDate is mandatory for tax invoices
 *   BR-KSA-16  PaymentMeansCode ∈ {10, 30, 42, 48, 1}
 *   BR-KSA-17  credit/debit notes carry PaymentMeans/InstructionNote
 *   BR-KSA-27  QR AdditionalDocumentReference with mimeCode="text/plain"
 *   BR-KSA-33/34  ICV reference carries a digit-only UUID
 *   BR-KSA-40/44  VAT numbers are 15 digits starting and ending with "3"
 *   BR-KSA-50/51  line VAT = net × rate ; RoundingAmount = net + VAT
 *   BR-KSA-56  credit notes reference the original invoice
 *   BR-KSA-68  TaxCurrencyCode is mandatory (SAR)
 *   BR-KSA-CL-04/05  exemption code + text vocabulary (see ./exemption.ts)
 *   BR-KSA-EN16931-01/02/08/09  ProfileID reporting:1.0, SAR, two TaxTotals
 *
 * The XAdES signature and the QR TLV live in ./signature.ts; a document without
 * signing material is returned unsigned — never with a fabricated stamp (D-012).
 */

import {
  canonicalizeForHash,
  initialPih,
  sha256B64Raw,
  sha256Hex,
  signInvoice,
  simplifiedQr,
  standardQr,
} from "./signature";
import {
  exemptionByCode,
  resolveExemption,
  type ExemptionConfig,
  type TaxCategoryCode,
} from "./exemption";

export type DocType = "simplified" | "standard";
export type DocSubtype = "invoice" | "credit_note" | "debit_note";

export { resolveExemption };
export type { TaxCategoryCode };

/** KSA-2 transaction flags: NN + third party + nominal + export + summary + self-billed. */
export interface TransactionFlags {
  thirdParty?: boolean;
  nominalSupply?: boolean;
  export?: boolean;
  summary?: boolean;
  selfBilled?: boolean;
}

const SUBTYPE_CODE: Record<DocSubtype, string> = {
  invoice: "388",
  credit_note: "381",
  debit_note: "383",
};

/**
 * KSA-2 invoice transaction code (BR-KSA-06, BR-KSA-31): positions 1-2 are the
 * subtype (01 standard, 02 simplified) and positions 3-7 are boolean flags.
 * Simplified documents may not use the export position (BR-KSA-31).
 */
export function transactionCode(docType: DocType, flags: TransactionFlags = {}): string {
  const bit = (v: boolean | undefined) => (v ? "1" : "0");
  const prefix = docType === "simplified" ? "02" : "01";
  return `${prefix}${bit(flags.thirdParty)}${bit(flags.nominalSupply)}${bit(
    docType === "standard" ? flags.export : false,
  )}${bit(flags.summary)}${bit(flags.selfBilled)}`;
}

export interface SellerIdentity {
  registrationName: string;
  vatNumber: string;
  crn: string | null;
  street: string | null;
  additionalStreet?: string | null;
  buildingNo?: string | null;
  plotIdentification?: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
}

export interface BuyerIdentity {
  registrationName: string | null;
  vatNumber: string | null;
  /** buyer identification when it is not a VAT number (NAT / CRN / MOM …) */
  identification?: { schemeId: string; value: string } | null;
  street?: string | null;
  additionalStreet?: string | null;
  buildingNo?: string | null;
  plotIdentification?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
}

export interface XmlLine {
  lineNo: number;
  productName: string;
  qty: string;
  /** UN/ECE Recommendation 20 unit code (PCE, EA, KGM, LTR …) */
  unitCode?: string;
  unitPrice: string;
  lineNet: string;
  discountAmount: string;
  vatRate: string;
  vatAmount: string;
  taxCategory: TaxCategoryCode;
  free: boolean;
}

export interface TaxSubtotalInput {
  category: TaxCategoryCode;
  rate: string;
  taxable: string;
  tax: string;
  exemptionReasonCode?: string | null;
  exemptionReason?: string | null;
  includePercent?: boolean;
}

export interface InvoiceXmlInput {
  invoiceNumber: string;
  uuid: string;
  icv: number;
  previousHashB64: string;
  issueDate: string;
  issueTime: string;
  docType: DocType;
  docSubtype: DocSubtype;
  transactionFlags?: TransactionFlags;
  currency: string;
  seller: SellerIdentity;
  buyer: BuyerIdentity | null;
  /** supply date (KSA-5) — mandatory for standard tax invoices */
  deliveryDate: string;
  /** UN/ECE 4461 codes; at least one (BR-KSA-16) */
  paymentMeansCodes: string[];
  /** reason for issuing a credit/debit note (BR-KSA-17, ≤127 chars) */
  instructionNote?: string | null;
  netTotal: string;
  discountTotal: string;
  vatTotal: string;
  totalWithVat: string;
  prepaidTotal?: string;
  taxSubtotals: TaxSubtotalInput[];
  lines: XmlLine[];
  billingReference?: { invoiceNumber: string; uuid?: string | null } | null;
  /** when null the document stays unsigned — no QR, no fabricated stamp (D-012) */
  signature: {
    certificateB64Der: string;
    privateKeyPem: string;
    signingTimeIso: string;
  } | null;
}

export { initialPih, canonicalizeForHash, signInvoice };

/** UN/ECE 4461 payment means used by the product (BR-KSA-16 allow-list). */
export const PAYMENT_MEANS = {
  cash: "10",
  credit: "30",
  bankTransfer: "42",
  card: "48",
  other: "1",
} as const;

export type PaymentMeansCode = (typeof PAYMENT_MEANS)[keyof typeof PAYMENT_MEANS];
export const ALLOWED_PAYMENT_MEANS: readonly string[] = Object.values(PAYMENT_MEANS);

/**
 * Map the product's payment methods (enum: cash · bank_transfer · card · other)
 * to UBL codes. Empty/unknown methods fall back to "1" — instrument not defined
 * — which is inside the allow-list (better than a wrong means).
 */
export function paymentMeansCodesFor(methods: string[]): string[] {
  if (methods.length === 0) return [PAYMENT_MEANS.credit];
  const codes = methods.map((m) => {
    if (m === "cash") return PAYMENT_MEANS.cash;
    if (m === "bank_transfer") return PAYMENT_MEANS.bankTransfer;
    if (m === "card") return PAYMENT_MEANS.card;
    return PAYMENT_MEANS.other;
  });
  return [...new Set(codes)];
}

const esc = (v: string): string =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const d2 = (v: string | number): string => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
};
const qty6 = (v: string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(6) : "0.000000";
};
const pct2 = (v: string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
};

function postalAddress(
  a: {
    street?: string | null;
    additionalStreet?: string | null;
    buildingNo?: string | null;
    plotIdentification?: string | null;
    district?: string | null;
    city?: string | null;
    postalCode?: string | null;
    countryCode?: string | null;
  },
  indent: string,
): string {
  const optional = (tag: string, value: string | null | undefined) =>
    value ? `${indent}    <cbc:${tag}>${esc(value)}</cbc:${tag}>\n` : "";
  return `${indent}<cac:PostalAddress>
${optional("StreetName", a.street)}${optional("AdditionalStreetName", a.additionalStreet)}${optional("BuildingNumber", a.buildingNo)}${optional("PlotIdentification", a.plotIdentification)}${optional("CitySubdivisionName", a.district)}${optional("CityName", a.city)}${optional("PostalZone", a.postalCode)}${indent}    <cac:Country>
${indent}        <cbc:IdentificationCode>${esc(a.countryCode ?? "SA")}</cbc:IdentificationCode>
${indent}    </cac:Country>
${indent}</cac:PostalAddress>`;
}

function taxCategoryXml(
  indent: string,
  opts: {
    category: TaxCategoryCode;
    rate: string;
    includePercent?: boolean;
    exemptionReasonCode?: string | null;
    exemptionReason?: string | null;
    /** the document-level AllowanceCharge/TaxSubtotal form carries scheme ids */
    schemeAttributes?: boolean;
  },
): string {
  const idAttrs = opts.schemeAttributes ? ' schemeID="UN/ECE 5305" schemeAgencyID="6"' : "";
  const schemeAttrs = opts.schemeAttributes ? ' schemeID="UN/ECE 5153" schemeAgencyID="6"' : "";
  const percent =
    opts.includePercent === false
      ? ""
      : `${indent}    <cbc:Percent>${pct2(opts.rate)}</cbc:Percent>\n`;
  const reasonCode = opts.exemptionReasonCode
    ? `${indent}    <cbc:TaxExemptionReasonCode>${esc(opts.exemptionReasonCode)}</cbc:TaxExemptionReasonCode>\n`
    : "";
  const reason = opts.exemptionReason
    ? `${indent}    <cbc:TaxExemptionReason>${esc(opts.exemptionReason)}</cbc:TaxExemptionReason>\n`
    : "";
  return `${indent}<cac:TaxCategory>
${indent}    <cbc:ID${idAttrs}>${opts.category}</cbc:ID>
${percent}${reasonCode}${reason}${indent}    <cac:TaxScheme>
${indent}        <cbc:ID${schemeAttrs}>VAT</cbc:ID>
${indent}    </cac:TaxScheme>
${indent}</cac:TaxCategory>`;
}

/** `cac:TaxCategory` → `cac:ClassifiedTaxCategory` (line item level). */
function classifiedTaxCategoryXml(
  indent: string,
  opts: { category: TaxCategoryCode; rate: string; includePercent?: boolean },
): string {
  const percent =
    opts.includePercent === false ? "" : `${indent}    <cbc:Percent>${pct2(opts.rate)}</cbc:Percent>\n`;
  return `${indent}<cac:ClassifiedTaxCategory>
${indent}    <cbc:ID>${opts.category}</cbc:ID>
${percent}${indent}    <cac:TaxScheme>
${indent}        <cbc:ID>VAT</cbc:ID>
${indent}    </cac:TaxScheme>
${indent}</cac:ClassifiedTaxCategory>`;
}

/** Render the document with empty UBLExtensions and no QR (hash input shape). */
function renderUnsigned(input: InvoiceXmlInput): string {
  const sb = input.seller;
  const buyer = input.buyer;
  const currency = input.currency;

  const supplier = `<cac:AccountingSupplierParty>
    <cac:Party>
      ${
        sb.crn
          ? `<cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${esc(sb.crn)}</cbc:ID>
      </cac:PartyIdentification>`
          : ""
      }
      ${postalAddress(sb, "      ")}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(sb.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(sb.registrationName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>`;

  const buyerIdentification = buyer?.identification
    ? `<cac:PartyIdentification>
        <cbc:ID schemeID="${esc(buyer.identification.schemeId)}">${esc(buyer.identification.value)}</cbc:ID>
      </cac:PartyIdentification>`
    : buyer?.vatNumber
      ? `<cac:PartyIdentification>
        <cbc:ID schemeID="NAT">${esc(buyer.vatNumber)}</cbc:ID>
      </cac:PartyIdentification>`
      : "";

  const buyerBlock = buyer
    ? `<cac:AccountingCustomerParty>
    <cac:Party>
      ${buyerIdentification}
      ${postalAddress(buyer, "      ")}
      <cac:PartyTaxScheme>
        ${buyer.vatNumber ? `<cbc:CompanyID>${esc(buyer.vatNumber)}</cbc:CompanyID>` : ""}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(buyer.registrationName ?? "")}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`
    : "";

  const instructionNote = input.instructionNote
    ? `\n    <cbc:InstructionNote>${esc(input.instructionNote)}</cbc:InstructionNote>`
    : "";
  const paymentMeans = input.paymentMeansCodes
    .map(
      (code) => `<cac:PaymentMeans>
    <cbc:PaymentMeansCode>${esc(code)}</cbc:PaymentMeansCode>${instructionNote}
  </cac:PaymentMeans>`,
    )
    .join("\n  ");

  const allowance =
    Number(input.discountTotal) !== 0
      ? `<cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="${currency}">${d2(input.discountTotal)}</cbc:Amount>
    ${taxCategoryXml("    ", { category: "S", rate: "15", schemeAttributes: true })}
  </cac:AllowanceCharge>`
      : "";

  const taxSubtotals = input.taxSubtotals
    .map(
      (s) => `<cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${currency}">${d2(s.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${currency}">${d2(s.tax)}</cbc:TaxAmount>
      ${taxCategoryXml("      ", {
        category: s.category,
        rate: s.rate,
        includePercent: s.includePercent !== false && s.category !== "O",
        exemptionReasonCode: s.exemptionReasonCode,
        exemptionReason: s.exemptionReason,
        schemeAttributes: true,
      })}
    </cac:TaxSubtotal>`,
    )
    .join("\n    ");

  const lines = input.lines
    .map(
      (l) => `<cac:InvoiceLine>
    <cbc:ID>${l.lineNo}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${esc(l.unitCode ?? "PCE")}">${qty6(l.qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${d2(l.lineNet)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${currency}">${d2(l.vatAmount)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${currency}">${d2(Number(l.lineNet) + Number(l.vatAmount))}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${esc(l.productName)}</cbc:Name>
      ${classifiedTaxCategoryXml("      ", {
        category: l.taxCategory,
        rate: l.vatRate,
        // official samples: an out-of-scope line carries no cbc:Percent
        // (Zero_Rate/Exempt samples keep Percent 0.00; Out_Of_Scope omits it)
        includePercent: l.taxCategory !== "O",
      })}
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${d2(l.unitPrice)}</cbc:PriceAmount>
      ${
        Number(l.discountAmount) !== 0
          ? `<cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
        <cbc:Amount currencyID="${currency}">${d2(l.discountAmount)}</cbc:Amount>
      </cac:AllowanceCharge>`
          : ""
      }
    </cac:Price>
  </cac:InvoiceLine>`,
    )
    .join("\n  ");

  const billingReference = input.billingReference
    ? `<cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(input.billingReference.invoiceNumber)}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  `
    : "";

  const prepaid = `\n    <cbc:PrepaidAmount currencyID="${currency}">${d2(input.prepaidTotal ?? "0")}</cbc:PrepaidAmount>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions/>
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(input.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${esc(input.uuid)}</cbc:UUID>
  <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${input.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${transactionCode(input.docType, input.transactionFlags)}">${SUBTYPE_CODE[input.docSubtype]}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${esc(currency)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  ${billingReference}<cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${input.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${esc(input.previousHashB64)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <!--QR_PLACEHOLDER-->
  ${supplier}
  ${buyerBlock}
  <cac:Delivery>
    <cbc:ActualDeliveryDate>${input.deliveryDate}</cbc:ActualDeliveryDate>
  </cac:Delivery>
  ${paymentMeans}
  ${allowance}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${d2(input.vatTotal)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${d2(input.vatTotal)}</cbc:TaxAmount>
    ${taxSubtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${d2(input.netTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${d2(input.netTotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${d2(input.totalWithVat)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${currency}">${d2(input.discountTotal)}</cbc:AllowanceTotalAmount>${prepaid}
    <cbc:PayableAmount currencyID="${currency}">${d2(input.totalWithVat)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lines}
</Invoice>`;
}

const QR_REFERENCE = (qr: string) => `<cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>`;

const SIGNATURE_REFERENCE = `<cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
  </cac:Signature>`;

/** The document with the QR reference and `cac:Signature` in place but unsigned. */
export function buildUnsignedWithQrReference(input: InvoiceXmlInput): string {
  const unsigned = renderUnsigned(input);
  if (input.docType === "standard") {
    // standard documents are cleared by the platform; the returned stamped copy
    // carries the full QR, so the pre-clearance copy carries the 5 clear-text tags
    return unsigned.replace(
      "  <!--QR_PLACEHOLDER-->",
      `${QR_REFERENCE("")}\n  ${SIGNATURE_REFERENCE}`,
    );
  }
  return unsigned.replace("  <!--QR_PLACEHOLDER-->", `${QR_REFERENCE("")}\n  ${SIGNATURE_REFERENCE}`);
}

/**
 * Build the invoice document. With signing material present the document is
 * signed (XAdES-BES) and carries its QR; otherwise it is returned unsigned —
 * never with a fabricated stamp (D-012).
 */
export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const unsigned = renderUnsigned(input);
  if (!input.signature) return unsigned.replace("  <!--QR_PLACEHOLDER-->\n", "");

  const withShell = unsigned.replace("  <!--QR_PLACEHOLDER-->", `${QR_REFERENCE("")}\n  ${SIGNATURE_REFERENCE}`);
  const signed = signInvoice({
    invoiceXml: withShell,
    certificateB64Der: input.signature.certificateB64Der,
    privateKeyPem: input.signature.privateKeyPem,
    signingTimeIso: input.signature.signingTimeIso,
  });

  const qr =
    input.docType === "simplified"
      ? simplifiedQr({
          sellerName: input.seller.registrationName,
          vatNumber: input.seller.vatNumber,
          issueDate: input.issueDate,
          issueTime: input.issueTime,
          totalWithVat: d2(input.totalWithVat),
          vatTotal: d2(input.vatTotal),
          invoiceHashB64: signed.invoiceHashB64,
          signatureValueB64: signed.signatureValueB64,
          publicKeySpkiDer: signed.certificate.publicKeySpkiDer,
          certificateSignature: signed.certificate.signatureValue,
        })
      : standardQr({
          sellerName: input.seller.registrationName,
          vatNumber: input.seller.vatNumber,
          issueDate: input.issueDate,
          issueTime: input.issueTime,
          totalWithVat: d2(input.totalWithVat),
          vatTotal: d2(input.vatTotal),
        });

  // QR placeholder → real value (identical byte length does not matter: the QR
  // reference is excluded from the hash on both the signing and the verifying side)
  return signed.signedXml.replace(
    /<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/,
    QR_REFERENCE(qr),
  );
}

/**
 * Invoice hash (IZ §4): canonicalize with UBLExtensions, `cac:Signature` and the
 * QR reference removed, then SHA-256. `b64` (base64 of the raw digest) is the
 * API `invoiceHash`, the QR tag-6 value and the PIH carried by the next invoice.
 */
export function computeInvoiceHash(xml: string): { hex: string; b64: string } {
  const parts = canonicalizeForHash(xml);
  return { hex: parts.hex, b64: parts.b64 };
}

/** QR timestamp convention (BR-KSA / SDK samples): "<IssueDate>T<IssueTime>Z". */
export function qrTimestamp(issueDate: string, issueTime: string): string {
  return `${issueDate}T${issueTime}Z`;
}

export function hexToB64(hex: string): string {
  return Buffer.from(hex, "utf8").toString("base64");
}

/* ------------------------------------------------------------ pre-flight QA */
export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  field: string;
  messageKey: string;
  value?: string;
}

/**
 * Local pre-flight mirroring the KSA rules we can evaluate without an XSLT-2
 * schematron engine (see the rule table in the module docblock). The portal's
 * compliance check stays the authority — this only blocks obviously-doomed
 * submissions with an actionable message.
 */
export function validateInvoiceXml(xml: string, input?: InvoiceXmlInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, field: string, messageKey: string, value?: string) =>
    issues.push({ severity: "error", code, field, messageKey, value });
  const warn = (code: string, field: string, messageKey: string, value?: string) =>
    issues.push({ severity: "warning", code, field, messageKey, value });
  const has = (needle: string) => xml.includes(needle);

  if (!/^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(xml)) {
    err("BR-KSA-CL-00", "xml", "tax.validation.xmlDeclarationMissing");
  }
  // BR-KSA-EN16931-01 / BR-KSA-68
  if (!has("<cbc:ProfileID>reporting:1.0</cbc:ProfileID>")) {
    err("BR-KSA-EN16931-01", "ProfileID", "tax.validation.profileIdInvalid");
  }
  if (!/<cbc:TaxCurrencyCode>SAR<\/cbc:TaxCurrencyCode>/.test(xml)) {
    err("BR-KSA-EN16931-02", "TaxCurrencyCode", "tax.validation.taxCurrencyNotSar");
  }
  // BR-KSA-EN16931-08/09 — exactly two TaxTotals when the tax currency is given,
  // one of them carrying the subtotals
  // document level only — each InvoiceLine carries its own cac:TaxTotal
  const documentLevel = xml.replace(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g, "");
  const taxTotals = documentLevel.match(/<cac:TaxTotal>/g)?.length ?? 0;
  const subtotalCount = documentLevel.match(/<cac:TaxSubtotal>/g)?.length ?? 0;
  if (taxTotals !== 2 || subtotalCount < 1) {
    err("BR-KSA-EN16931-09", "TaxTotal", "tax.validation.taxTotalCount", String(taxTotals));
  }
  // BR-KSA-33/34 — ICV reference with a digit-only UUID (≤19 chars)
  const icv = /<cac:AdditionalDocumentReference>\s*<cbc:ID>ICV<\/cbc:ID>\s*<cbc:UUID>(\d{1,19})<\/cbc:UUID>/.exec(
    xml,
  );
  if (!icv) err("BR-KSA-33", "ICV", "tax.validation.icvInvalid");
  // BR-KSA-61/26 — PIH present, mimeCode text/plain, base64 (≤64 chars)
  const pih = /<cbc:ID>PIH<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([^<]+)</.exec(
    xml,
  );
  if (!pih) err("BR-KSA-61", "PIH", "tax.validation.pihMissing");
  else {
    // KSA-13 caps the *hash* at 64 chars: the samples carry base64 of either the
    // raw 32-byte digest or the 64-char hex text (BR-KSA-26 genesis).
    const raw = Buffer.from(pih[1].trim(), "base64");
    const asText = raw.toString("utf8");
    if (!(raw.length === 32 || (raw.length === 64 && /^[0-9a-f]{64}$/.test(asText)))) {
      err("KSA-13", "PIH", "tax.validation.pihEncoding");
    }
  }
  // BR-KSA-03 — UUID with letters/digits/dashes
  const uuid = /<cbc:UUID>([^<]+)<\/cbc:UUID>/.exec(xml);
  if (!uuid || !/^[\w.-]+$/.test(uuid[1])) err("BR-KSA-03", "UUID", "tax.validation.uuidInvalid");
  // BR-KSA-05/06/31 — invoice type code + transaction flags
  const typeName = /<cbc:InvoiceTypeCode name="(0[12][01]{5})">(\d{3})<\/cbc:InvoiceTypeCode>/.exec(xml);
  if (!typeName || !["388", "381", "383"].includes(typeName[2])) {
    err("BR-KSA-05", "InvoiceTypeCode", "tax.validation.typeCodeInvalid");
  } else if (typeName[1].startsWith("02") && typeName[1].charAt(4) === "1") {
    err("BR-KSA-31", "InvoiceTypeCode", "tax.validation.exportFlagOnSimplified");
  }
  // BR-KSA-15/35/72 — supply date
  if (!/<cac:Delivery>\s*<cbc:ActualDeliveryDate>\d{4}-\d{2}-\d{2}<\/cbc:ActualDeliveryDate>/.test(xml)) {
    err("BR-KSA-15", "Delivery", "tax.validation.deliveryDateMissing");
  }
  // BR-KSA-27 — QR reference with text/plain payload (signed simplified docs)
  if (typeName?.[1].startsWith("02")) {
    const qr = /<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([^<]*)</.exec(
      xml,
    );
    if (!qr) err("BR-KSA-27", "QR", "tax.validation.qrMissing");
    else {
      if (!qr[1]) err("BR-KSA-27", "QR", "tax.validation.qrEmpty");
      if (qr[1] && qr[1].length > 700) err("KSA-14", "QR", "tax.validation.qrTooLong");
    }
  }
  // BR-KSA-16 — payment means inside the allow-list
  for (const m of xml.matchAll(/<cbc:PaymentMeansCode>([^<]+)<\/cbc:PaymentMeansCode>/g)) {
    if (!ALLOWED_PAYMENT_MEANS.includes(m[1])) {
      err("BR-KSA-16", "PaymentMeansCode", "tax.validation.paymentMeansInvalid", m[1]);
    }
  }
  if (!has("<cac:PaymentMeans>")) {
    err("BR-KSA-16", "PaymentMeans", "tax.validation.paymentMeansMissing");
  }
  // BR-KSA-56/17 — credit/debit notes: billing reference + reason
  if (typeName && ["381", "383"].includes(typeName[2])) {
    if (!has("<cac:BillingReference>")) {
      err("BR-KSA-56", "BillingReference", "tax.validation.billingReferenceMissing");
    }
    if (!has("<cbc:InstructionNote>")) {
      err("BR-KSA-17", "InstructionNote", "tax.validation.instructionNoteMissing");
    }
  }
  for (const m of xml.matchAll(/<cbc:InstructionNote>([^<]*)<\/cbc:InstructionNote>/g)) {
    if (m[1].length < 1 || m[1].length > 127) {
      err("KSA-10", "InstructionNote", "tax.validation.noteLength");
    }
  }
  // BR-KSA-CL-04 — the Z/E categories must carry BOTH the reason code and text;
  // BR-KSA-CL-05 — the text must be one of the approved KSA texts for that code
  for (const block of xml.matchAll(/<cac:TaxSubtotal>[\s\S]*?<\/cac:TaxSubtotal>/g)) {
    const cat = /<cbc:ID[^>]*>([SZEO])<\/cbc:ID>/.exec(block[0])?.[1];
    if (cat === "Z" || cat === "E") {
      const code = /<cbc:TaxExemptionReasonCode>([^<]+)<\/cbc:TaxExemptionReasonCode>/.exec(block[0])?.[1];
      const reason = /<cbc:TaxExemptionReason>([^<]*)<\/cbc:TaxExemptionReason>/.exec(block[0])?.[1];
      if (!code || !reason) {
        err("BR-KSA-CL-04", `TaxCategory.${cat}`, "tax.validation.exemptionPairMissing", cat);
      } else {
        if (code.length > 13) err("BT-121", "TaxExemptionReasonCode", "tax.validation.exemptionCodeTooLong");
        if (reason.length > 127) err("BT-120", "TaxExemptionReason", "tax.validation.exemptionReasonTooLong");
        const approved = exemptionByCode(code);
        if (!approved || approved.category !== cat || approved.text !== reason) {
          err("BR-KSA-CL-05", `TaxCategory.${cat}`, "tax.validation.exemptionTextUnapproved", `${code}`);
        }
      }
    }
  }
  // BR-KSA-40/44 — VAT numbers
  const sellerVat = /<cac:AccountingSupplierParty>[\s\S]*?<cbc:CompanyID>([^<]+)<\/cbc:CompanyID>/.exec(xml)?.[1];
  if (sellerVat && !/^3\d{13}3$/.test(sellerVat)) {
    err("BR-KSA-40", "seller.vatNumber", "tax.validation.vatFormat");
  }
  const buyerVat = /<cac:AccountingCustomerParty>[\s\S]*?<cbc:CompanyID>([^<]+)<\/cbc:CompanyID>/.exec(xml)?.[1];
  if (buyerVat && !/^3\d{13}3$/.test(buyerVat) && typeName?.[1].charAt(4) !== "1") {
    err("BR-KSA-44", "buyer.vatNumber", "tax.validation.vatFormat");
  }
  // signature presence for the documents that require a stamp (BR-KSA-60)
  const signed = xml.includes("<ds:SignatureValue>");
  if (!signed) err("BR-KSA-60", "Signature", "tax.validation.unsigned");
  if (signed && !has(QR_REFERENCE("").trim().split("\n")[0])) {
    // QR reference must exist in signed documents (BR-KSA-27 covers simplified)
    if (!/<cbc:ID>QR<\/cbc:ID>/.test(xml)) err("BR-KSA-27", "QR", "tax.validation.qrMissing");
  }

  if (input) {
    if (input.docType === "standard") {
      const b = input.buyer;
      const complete = Boolean(
        b?.street && b?.buildingNo && b?.plotIdentification && b?.district && b?.city && b?.postalCode,
      );
      if (!complete) err("BR-KSA-63", "buyer.address", "tax.validation.buyerAddressIncomplete");
      if (!b?.registrationName) err("BR-42", "buyer.registrationName", "tax.validation.buyerNameMissing");
      if (b?.vatNumber && !/^3\d{13}3$/.test(b.vatNumber)) {
        err("BR-KSA-44", "buyer.vatNumber", "tax.validation.vatFormat");
      }
    }
    const sellerComplete = Boolean(
      input.seller.street &&
        input.seller.buildingNo &&
        input.seller.plotIdentification &&
        input.seller.district &&
        input.seller.city &&
        input.seller.postalCode,
    );
    if (!sellerComplete) err("BR-KSA-09", "seller.address", "tax.validation.sellerAddressIncomplete");
    if (input.seller.plotIdentification && !/^\d{4}$/.test(input.seller.plotIdentification)) {
      err("BR-KSA-64", "seller.plotIdentification", "tax.validation.plotIdFormat");
    }
    if (input.seller.buildingNo && !/^\d{4}$/.test(input.seller.buildingNo)) {
      err("BR-KSA-37", "seller.buildingNo", "tax.validation.buildingNoFormat");
    }
    if (input.seller.postalCode && !/^\d{5}$/.test(input.seller.postalCode)) {
      err("BR-KSA-66", "seller.postalCode", "tax.validation.postalCodeFormat");
    }
    if (input.currency !== "SAR") {
      err("BR-KSA-EN16931-02", "currency", "tax.validation.currencyNotSar", input.currency);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate)) {
      err("BR-KSA-F-01", "deliveryDate", "tax.validation.dateFormat");
    }
    if (input.deliveryDate > input.issueDate) {
      err("BR-KSA-36", "deliveryDate", "tax.validation.deliveryAfterIssue");
    }
    const today = new Date().toISOString().slice(0, 10);
    if (input.issueDate > today) {
      err("BR-KSA-04", "issueDate", "tax.validation.issueDateFuture");
    }
    // BR-KSA-50/51 + DEC-03/04 — line arithmetic
    for (const l of input.lines) {
      // vatRate is the UBL percent value ("15"), not a fraction
      const expectedVat = Number(((Number(l.lineNet) * Number(l.vatRate)) / 100).toFixed(2));
      if (Math.abs(expectedVat - Number(l.vatAmount)) > 0.005) {
        err(
          "BR-KSA-50",
          `line.${l.lineNo}`,
          "tax.validation.lineVatMismatch",
          `net=${l.lineNet} rate=${l.vatRate}% expected=${expectedVat.toFixed(2)} actual=${l.vatAmount}`,
        );
      }
      // a non-standard category (Z/E/O) never carries a positive rate
      // (house rule — the rule set encodes it through the exemption codes)
      if (l.taxCategory !== "S" && Number(l.vatRate) > 0) {
        err("HISAB-CAT-RATE", `line.${l.lineNo}`, "tax.validation.nonStandardRate", l.taxCategory);
      }
      if (l.taxCategory === "S" && Number(l.vatRate) <= 0 && !l.free) {
        warn("BR-KSA-CL-04", `line.${l.lineNo}`, "tax.validation.zeroRateStandardCategory");
      }
      if (l.productName.length > 127) {
        warn("BT-CL-153", `line.${l.lineNo}`, "tax.validation.itemNameTooLong");
      }
    }
    const sumTaxable = input.taxSubtotals.reduce((s, t) => s + Number(t.taxable), 0);
    if (Math.abs(sumTaxable - Number(input.netTotal)) > 0.01) {
      err("BR-KSA-CL-09", "totals", "tax.validation.taxableMismatch", String(sumTaxable));
    }
    const sumTax = input.taxSubtotals.reduce((s, t) => s + Number(t.tax), 0);
    if (Math.abs(sumTax - Number(input.vatTotal)) > 0.01) {
      err("BR-CO-14", "totals", "tax.validation.vatMismatch", String(sumTax));
    }
    if (Math.abs(Number(input.netTotal) + Number(input.vatTotal) - Number(input.totalWithVat)) > 0.01) {
      err("BR-CO-15", "totals", "tax.validation.totalMismatch");
    }
    // BR-KSA-DEC-01..05 — decimal precision is a property of the EMITTED document
    // (the in-memory buffers legitimately carry more places), so these rules read
    // the rendered XML exactly like the platform's validator does.
    const decimals = (value: string) => (value.split(".")[1] ?? "").length;
    const lineBlocks = [...xml.matchAll(/<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/g)];
    lineBlocks.forEach((m, i) => {
      const block = m[1];
      const at = `line.${i + 1}`;
      const lineTax = /<cac:TaxTotal>\s*<cbc:TaxAmount[^>]*>([\d.]+)<\/cbc:TaxAmount>/.exec(block)?.[1];
      if (lineTax && decimals(lineTax) > 2) {
        err("BR-KSA-DEC-03", at, "tax.validation.amountDecimals", lineTax);
      }
      const rounding = /<cbc:RoundingAmount[^>]*>([\d.]+)<\/cbc:RoundingAmount>/.exec(block)?.[1];
      if (rounding && decimals(rounding) > 2) {
        err("BR-KSA-DEC-04", at, "tax.validation.amountDecimals", rounding);
      }
      const price = /<cac:Price>\s*<cbc:PriceAmount[^>]*>([\d.]+)<\/cbc:PriceAmount>/.exec(block)?.[1];
      if (price && decimals(price) > 2) {
        err("BR-KSA-DEC-05", at, "tax.validation.amountDecimals", price);
      }
    });
    // BR-KSA-DEC-02 — VAT rates (BT-152) are percent 0.00..100.00, max two decimals
    for (const m of xml.matchAll(/<cbc:Percent>([^<]*)<\/cbc:Percent>/g)) {
      const v = m[1].trim();
      const n = Number(v);
      if (!/^\d+(\.\d+)?$/.test(v) || !(n >= 0 && n <= 100) || decimals(v) > 2) {
        err("BR-KSA-DEC-02", "Percent", "tax.validation.percentInvalid", v);
      }
    }
    // BR-KSA-DEC-01 — allowance/charge multiplier 0..100, max six decimals
    for (const m of xml.matchAll(/<cbc:MultiplierFactorNumeric>([^<]*)<\/cbc:MultiplierFactorNumeric>/g)) {
      const v = m[1].trim();
      const n = Number(v);
      if (!/^\d+(\.\d+)?$/.test(v) || !(n >= 0 && n <= 100) || decimals(v) > 6) {
        err("BR-KSA-DEC-01", "MultiplierFactorNumeric", "tax.validation.multiplierInvalid", v);
      }
    }
    // UN/ECE 4461 — every configured means must be a single allow-listed code
    for (const code of input.paymentMeansCodes) {
      if (!ALLOWED_PAYMENT_MEANS.includes(code)) {
        err("BR-KSA-16", "paymentMeansCodes", "tax.validation.paymentMeansInvalid", code);
      }
    }
  }
  return issues;
}

export { sha256B64Raw, sha256Hex };

/** Type guard used by callers that build from config. */
export function isExemptionConfig(value: unknown): value is ExemptionConfig {
  return typeof value === "object" && value !== null;
}
