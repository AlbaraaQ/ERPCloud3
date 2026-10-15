/**
 * UBL 2.1 KSA e-invoice XML generation.
 * Implements the KSA Electronic Invoice XML Implementation Standard
 * (FATOORA phase-2 shape: namespaces, type codes, tax scheme, QR reference,
 * UBLExtensions signature container). Field mapping is intentionally kept
 * in ONE place; the developer-portal compliance checks remain the acceptance
 * gate before production (per official onboarding flow).
 */

import { createHash } from "crypto";
import { b64 } from "./crypto";

export type DocType = "simplified" | "standard";
export type DocSubtype = "invoice" | "credit_note" | "debit_note";

/** UBL InvoiceTypeCode subtype names per official mapping (verify at onboarding). */
const SUBTYPE_NAME: Record<DocType, string> = {
  simplified: "0200000",
  standard: "0100000",
};
/** UBL InvoiceTypeCode values: 388 invoice / 381 credit note / 383 debit note. */
const SUBTYPE_CODE: Record<DocSubtype, string> = {
  invoice: "388",
  credit_note: "381",
  debit_note: "383",
};

export interface SellerIdentity {
  registrationName: string;
  vatNumber: string;
  crn: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
}

export interface BuyerIdentity {
  registrationName: string | null;
  vatNumber: string | null;
}

export interface XmlLine {
  lineNo: number;
  productName: string;
  qty: string;
  unitPrice: string; // net unit price (pre-VAT)
  lineNet: string;
  vatRate: string; // e.g. "15"
  vatAmount: string;
  discountAmount: string;
  free: boolean;
}

export interface InvoiceXmlInput {
  invoiceNumber: string; // e.g. "12"
  uuid: string;
  icv: number;
  previousHashB64: string;
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:MM:SS
  timezoneOffset: string; // "+03:00"
  docType: DocType;
  docSubtype: DocSubtype;
  currency: string; // "SAR"
  seller: SellerIdentity;
  buyer: BuyerIdentity | null;
  paymentMeansCode: string; // 10 cash · 30 credit transfer · 48 card
  netTotal: string;
  vatTotal: string;
  totalWithVat: string;
  discountTotal: string;
  lines: XmlLine[];
  /** UBLExtensions signature container values (only when device key exists) */
  signature: {
    valueB64: string;
    qrB64: string;
  } | null;
}

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const d2 = (v: string | number) => {
  const n = typeof v === "number" ? v : Number(v);
  return n.toFixed(2);
};

function address(a: Exclude<SellerIdentity, null> | { street: null }) {
  return `<cac:PostalAddress>
        <cbc:StreetName>${esc(a.street ?? "")}</cbc:StreetName>
        <cbc:AdditionalStreetName></cbc:AdditionalStreetName>
        <cbc:BuildingNumber></cbc:BuildingNumber>
        <cbc:PlotIdentification></cbc:PlotIdentification>
        <cbc:CitySubdivisionName>${""}</cbc:CitySubdivisionName>
        <cbc:CityName>${esc("city" in a && a.city ? a.city : "")}</cbc:CityName>
        <cbc:PostalZone>${esc("postalCode" in a && a.postalCode ? a.postalCode : "")}</cbc:PostalZone>
        <cbc:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cbc:Country>
      </cac:PostalAddress>`;
}

function partyTaxScheme(vat: string | null, schemeId = "VAT"): string {
  return `<cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(vat ?? "")}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>${schemeId}</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>`;
}

export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const typeName = SUBTYPE_NAME[input.docType];
  const typeCode = SUBTYPE_CODE[input.docSubtype];
  const sb = input.seller;

  const ublExt = input.signature
    ? `<ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionURI>urn:oasis:names:specification:ubl:signature:Invoice</ext:ExtensionURI>
      <ext:ExtensionContent>
        <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:documentSignatures" xmlns:sac="urn:oasis:names:specification:ubl:signatureaggregatecomponents">
          <sac:SignatureInformation>
            <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
            <cbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ReferencedSignatureID>
            <cbc:SignatureValue>${input.signature.valueB64}</cbc:SignatureValue>
          </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>`
    : "";

  const signatureBlock = input.signature
    ? `<cac:Signature>
      <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
      <cbc:SignatureMethod>urn:oasis:names:specification:ubl:signature:Invoice</cbc:SignatureMethod>
    </cac:Signature>`
    : "";

  const qrBlock = input.signature
    ? `<cac:AdditionalDocumentReference>
      <cbc:ID>QR</cbc:ID>
      <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${input.signature.qrB64}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
    </cac:AdditionalDocumentReference>`
    : "";

  const buyerBlock = input.buyer
    ? `<cac:AccountingCustomerParty>
      <cac:Party>
        ${partyTaxScheme(input.buyer.vatNumber)}
        <cac:PartyLegalEntity><cbc:RegistrationName>${esc(input.buyer.registrationName ?? "")}</cbc:RegistrationName></cac:PartyLegalEntity>
      </cac:Party>
    </cac:AccountingCustomerParty>`
    : "";

  const linesXml = input.lines
    .map((l) => `    <cac:InvoiceLine>
      <cbc:ID>${l.lineNo}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="EA">${l.qty}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${d2(l.lineNet)}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${input.currency}">${d2(l.vatAmount)}</cbc:TaxAmount>
        <cac:TaxSubtotal>
          <cbc:TaxableAmount currencyID="${input.currency}">${d2(l.lineNet)}</cbc:TaxableAmount>
          <cbc:TaxAmount currencyID="${input.currency}">${d2(l.vatAmount)}</cbc:TaxAmount>
          <cac:TaxCategory>
            <cbc:ID>S</cbc:ID>
            <cbc:Percent>${Number(l.vatRate).toFixed(2)}</cbc:Percent>
            <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
          </cac:TaxCategory>
        </cac:TaxSubtotal>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${esc(l.productName)}</cbc:Name>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${input.currency}">${d2(l.unitPrice)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  ${ublExt}
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(input.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${esc(input.uuid)}</cbc:UUID>
  <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${input.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${typeName}">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${input.currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${input.currency}</cbc:TaxCurrencyCode>
  <cbc:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID><cbc:UUID>${input.icv}</cbc:UUID>
  </cbc:AdditionalDocumentReference>
  <cbc:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${input.previousHashB64}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cbc:AdditionalDocumentReference>
  ${qrBlock}
  ${signatureBlock}
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="CRN">${esc(sb.crn ?? "")}</cbc:ID></cac:PartyIdentification>
      ${address(sb)}
      ${partyTaxScheme(sb.vatNumber)}
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(sb.registrationName)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  ${buyerBlock}
  <cac:Delivery>
    <cac:Address>${address(sb).replace(/<\/?cac:PostalAddress>/g, "")}</cac:Address>
  </cac:Delivery>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${input.paymentMeansCode}</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  ${input.discountTotal !== "0.00"
    ? `<cac:AllowanceCharge>
      <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
      <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
      <cbc:Amount currencyID="${input.currency}">${d2(input.discountTotal)}</cbc:Amount>
    </cac:AllowanceCharge>`
    : ""}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.currency}">${d2(input.vatTotal)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${input.currency}">${d2(input.netTotal)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${input.currency}">${d2(input.vatTotal)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotals>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${d2(input.netTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.currency}">${d2(input.netTotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.currency}">${d2(input.totalWithVat)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${input.currency}">${d2(input.totalWithVat)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotals>
${linesXml}
</Invoice>`;
}

/**
 * Invoice hash per the XML Implementation Standard: SHA-256 of the XML with
 * UBLExtensions, the cac:Signature block, and the QR reference removed,
 * whitespace-normalized (documented normalization; the developer-portal
 * compliance check is the final arbiter).
 * Returns base64 of the hex digest (SDK convention: hex is also encoded).
 */
export function computeInvoiceHash(xml: string): { hex: string; b64: string } {
  const stripped = xml
    .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/g, "")
    .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/g, "")
    .replace(/<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/g, "");
  const normalized = stripped
    .replace(/\r\n/g, "\n")
    .replace(/>\s+</g, "><")
    .trim();
  const hexDigest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return { hex: hexDigest, b64: b64(hexDigest) };
}

export function qrTimestamp(issueDate: string, issueTime: string, offset: string): string {
  return `${issueDate}T${issueTime}${offset}`;
}

export function hexToB64(hex: string): string {
  return b64(hex);
}
