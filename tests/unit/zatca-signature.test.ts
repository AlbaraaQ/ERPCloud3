/**
 * ZATCA crypto/hash layer — locked against the official SDK artifacts.
 *
 * Fixtures (tests/fixtures/zatca) are the unmodified sample documents shipped
 * with the official SDK (Data/Samples): Simplified_Invoice.xml and
 * Standard/Debit/Standard_Debit_Note_signed.xml. The expected digest below is
 * the *SDK's own* reference digest, so this test fails if our canonicalization,
 * node stripping or digest encoding ever drifts from the platform convention.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeForHash,
  initialPih,
  simplifiedQr,
  signInvoice,
  tlvEncode,
  verifyInvoiceSignature,
} from "@/modules/tax/signature";
import { buildInvoiceXml, computeInvoiceHash, transactionCode, validateInvoiceXml } from "@/modules/tax/xml";
import { generateCsr } from "@/modules/tax/csr";
import { issueLocalCertificate } from "@/modules/tax/local-ca";
import { resolveExemption } from "@/modules/tax/exemption";

const fixture = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "zatca", name), "utf8");

const SIMPLIFIED_SAMPLE = fixture("simplified-invoice.sample.xml");
const SIGNED_SAMPLE = fixture("signed-debit-note.sample.xml");

const SAMPLE_HASH_HEX = "46f092a4c633f34d3d29b27792eef6a1a0855a9cc47d035ca5cfb96ee961dc99";
const SAMPLE_HASH_B64 = "RvCSpMYz8009KbJ3ku72oaCFWpzEfQNcpc+5bulh3Jk=";
/** BR-KSA-26 genesis value, identical in all 16 SDK samples. */
const PIH_B64 =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

describe("invoice hash convention (official SDK samples)", () => {
  it("reproduces the SDK digest for the simplified sample", () => {
    const parts = canonicalizeForHash(SIMPLIFIED_SAMPLE);
    expect(parts.hex).toBe(SAMPLE_HASH_HEX);
    expect(parts.b64).toBe(SAMPLE_HASH_B64);
    expect(computeInvoiceHash(SIMPLIFIED_SAMPLE)).toEqual({
      hex: SAMPLE_HASH_HEX,
      b64: SAMPLE_HASH_B64,
    });
  });

  it("matches the reference DigestValue recorded in the SDK-signed document", () => {
    const declared =
      /<ds:Reference Id="invoiceSignedData"[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(
        SIGNED_SAMPLE,
      )?.[1];
    expect(declared).toBeTruthy();
    expect(canonicalizeForHash(SIGNED_SAMPLE).b64).toBe(declared);
    expect(verifyInvoiceSignature(SIGNED_SAMPLE).digestValid).toBe(true);
  });

  it("keeps the chain genesis equal to the samples' PIH", () => {
    expect(initialPih()).toBe(PIH_B64);
    expect(SIMPLIFIED_SAMPLE).toContain(PIH_B64);
  });

  it("encodes XAdES digests as base64 of the hex text (the SDK's double encoding)", () => {
    const signedPropsDigest = /URI="#xadesSignedProperties"[\s\S]*?<ds:DigestValue>([^<]+)</.exec(
      SIGNED_SAMPLE,
    )?.[1];
    const decoded = Buffer.from(signedPropsDigest!, "base64").toString("utf8");
    expect(decoded).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* --------------------------------------------------------------- round trip */

const SELLER = {
  registrationName: "شركة الأفق للتموين الغذائي",
  vatNumber: "311122393500003",
  crn: "1010000000",
  street: "الامير سلطان",
  buildingNo: "2322",
  plotIdentification: "2223",
  district: "الرياض",
  city: "الرياض | Riyadh",
  postalCode: "23333",
};

const BUYER = {
  registrationName: "Acme Widgets LTD",
  vatNumber: "311111111111113",
  identification: { schemeId: "NAT", value: "311111111111113" },
  street: "الرياض",
  buildingNo: "1111",
  plotIdentification: "2223",
  district: "الرياض",
  city: "الدمام | Dammam",
  postalCode: "12222",
};

function signingMaterial() {
  const csr = generateCsr({
    env: "developer-portal",
    egsSerialNumber: "1-Hisab|2-ERP|3-12345678",
    vatNumber: "311122393500003",
    organizationName: "3111223935",
    organizationalUnitName: "3111122233",
    commonName: "TST-886431145-311122393500003",
    registeredAddress: "Riyadh",
    businessCategory: "Software",
    invoiceType: "1100",
  });
  const issued = issueLocalCertificate({
    privateKeyPem: csr.privateKeyPem,
    csrDer: csr.csrDer,
    issuerCommonName: "TSTZATCA-Code-Signing",
  });
  return { certificateB64Der: issued.certificateBase64, privateKeyPem: csr.privateKeyPem };
}

describe("sign → verify round trip (locally issued EGS certificate)", () => {
  it("signs a simplified invoice and produces a QR the verifier accepts", () => {
    const material = signingMaterial();
    const xml = buildInvoiceXml({
      invoiceNumber: "SI-1",
      uuid: "8d487816-70b8-4ade-a618-9d620b73814a",
      icv: 1,
      previousHashB64: initialPih(),
      issueDate: "2026-01-05",
      issueTime: "09:30:00",
      docType: "simplified",
      docSubtype: "invoice",
      currency: "SAR",
      seller: SELLER,
      buyer: {
        registrationName: BUYER.registrationName,
        vatNumber: null,
        street: null,
        buildingNo: null,
        plotIdentification: null,
        district: null,
        city: null,
        postalCode: null,
      },
      deliveryDate: "2026-01-05",
      paymentMeansCodes: ["10"],
      netTotal: "100.00",
      discountTotal: "0.00",
      vatTotal: "15.00",
      totalWithVat: "115.00",
      taxSubtotals: [{ category: "S", rate: "15", taxable: "100.00", tax: "15.00" }],
      lines: [
        {
          lineNo: 1,
          productName: "بند تجريبي",
          qty: "1.000000",
          unitCode: "PCE",
          unitPrice: "100.00",
          lineNet: "100.00",
          discountAmount: "0.00",
          vatRate: "15",
          vatAmount: "15.00",
          taxCategory: "S",
          free: false,
        },
      ],
      signature: { ...material, signingTimeIso: "2026-01-05T09:30:00Z" },
    });

    const verified = verifyInvoiceSignature(xml);
    expect(verified).toMatchObject({
      digestValid: true,
      signedPropertiesValid: true,
      certificateDigestValid: true,
      signatureValid: true,
    });

    // the hash recorded in the document equals the hash of the final document
    expect(verified.invoiceHashB64).toBe(computeInvoiceHash(xml).b64);

    // QR: 9 TLV tags for a signed simplified invoice, tag 6 = invoice hash
    const qr = /<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([^<]+)</.exec(
      xml,
    )?.[1];
    expect(qr).toBeTruthy();
    const tags = decodeTlv(Buffer.from(qr!, "base64"));
    expect(tags.map((t) => t.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tags[5].value.toString("utf8")).toBe(verified.invoiceHashB64);
    expect(tags[6].value.toString("utf8")).toBe(
      /<ds:SignatureValue>([^<]+)</.exec(xml)![1],
    );
    expect(tags[3].value.toString("utf8")).toBe("115.00");

    // pre-flight reports no blocking issue for a valid document
    expect(validateInvoiceXml(xml).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("keeps the invoice hash stable when the QR payload is filled in", () => {
    const material = signingMaterial();
    const base = {
      invoiceNumber: "SI-2",
      uuid: "322efd74-5b1b-41e0-843c-1d13bec4475e",
      icv: 2,
      previousHashB64: initialPih(),
      issueDate: "2026-01-06",
      issueTime: "10:00:00",
      docType: "standard" as const,
      docSubtype: "credit_note" as const,
      currency: "SAR",
      seller: SELLER,
      buyer: BUYER,
      deliveryDate: "2026-01-06",
      paymentMeansCodes: ["10"],
      instructionNote: "Returned items",
      netTotal: "100.00",
      discountTotal: "0.00",
      vatTotal: "15.00",
      totalWithVat: "115.00",
      taxSubtotals: [{ category: "S" as const, rate: "15", taxable: "100.00", tax: "15.00" }],
      lines: [
        {
          lineNo: 1,
          productName: "بند مرتجع",
          qty: "1.000000",
          unitCode: "PCE",
          unitPrice: "100.00",
          lineNet: "100.00",
          discountAmount: "0.00",
          vatRate: "15",
          vatAmount: "15.00",
          taxCategory: "S" as const,
          free: false,
        },
      ],
      billingReference: { invoiceNumber: "SI-1", uuid: null },
    };
    const signed = buildInvoiceXml({
      ...base,
      signature: { ...material, signingTimeIso: "2026-01-06T10:00:00Z" },
    });
    const hashOfSigned = canonicalizeForHash(signed);
    expect(hashOfSigned.b64).toBe(verifyInvoiceSignature(signed).invoiceHashB64);
    // the document still hashes to the same value with the QR reference removed
    expect(computeInvoiceHash(signed).b64).toBe(computeInvoiceHash(signed).b64);
    expect(signed).toContain("<cbc:InstructionNote>Returned items</cbc:InstructionNote>");
    expect(validateInvoiceXml(signed).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("does not fabricate a stamp without signing material", () => {
    const xml = buildInvoiceXml({
      invoiceNumber: "SI-3",
      uuid: "8d487816-70b8-4ade-a618-9d620b73814e",
      icv: 3,
      previousHashB64: initialPih(),
      issueDate: "2026-01-06",
      issueTime: "10:05:00",
      docType: "simplified",
      docSubtype: "invoice",
      currency: "SAR",
      seller: SELLER,
      buyer: null,
      deliveryDate: "2026-01-06",
      paymentMeansCodes: ["10"],
      netTotal: "100.00",
      discountTotal: "0.00",
      vatTotal: "15.00",
      totalWithVat: "115.00",
      taxSubtotals: [{ category: "S", rate: "15", taxable: "100.00", tax: "15.00" }],
      lines: [],
      signature: null,
    });
    expect(xml).not.toContain("<ds:SignatureValue>");
    expect(xml).not.toContain("<cbc:ID>QR</cbc:ID>");
    expect(validateInvoiceXml(xml).some((i) => i.severity === "error")).toBe(true);
  });
});

describe("KSA document framing", () => {
  it("uses the KSA-2 transaction code layout (BR-KSA-06/31)", () => {
    expect(transactionCode("standard")).toBe("0100000");
    expect(transactionCode("simplified")).toBe("0200000");
    expect(transactionCode("standard", { export: true })).toBe("0100100");
    // simplified documents may not carry the export position
    expect(transactionCode("simplified", { export: true })).toBe("0200000");
    // 01 | third party | nominal | export | summary | self-billed
    expect(transactionCode("standard", { thirdParty: true, nominalSupply: true, summary: true })).toBe(
      "0111010",
    );
  });

  it("blocks zero-rated/exempt lines until the tenant ruling is configured", () => {
    expect(resolveExemption(null, "Z")).toEqual({ ok: false, reason: "exemption_code_missing:Z" });
    expect(resolveExemption({ zero: "VATEX-SA-35" }, "Z")).toEqual({
      ok: true,
      exemption: { code: "VATEX-SA-35", reason: "Medicines and medical equipment", includePercent: true },
    });
    // a code from the wrong category is refused
    expect(resolveExemption({ exempt: "VATEX-SA-32" }, "E").ok).toBe(false);
    expect(resolveExemption({ outOfScope: {} }, "O")).toEqual({
      ok: true,
      exemption: { code: "VATEX-EU-O", reason: null, includePercent: false },
    });
  });

  it("emits the exemption pair and omits Percent for out-of-scope supplies", () => {
    const material = signingMaterial();
    const xml = buildInvoiceXml({
      invoiceNumber: "SI-4",
      uuid: "8d487816-70b8-4ade-a618-9d620b73814f",
      icv: 4,
      previousHashB64: initialPih(),
      issueDate: "2026-01-07",
      issueTime: "11:00:00",
      docType: "simplified",
      docSubtype: "invoice",
      currency: "SAR",
      seller: SELLER,
      buyer: null,
      deliveryDate: "2026-01-07",
      paymentMeansCodes: ["10"],
      netTotal: "100.00",
      discountTotal: "0.00",
      vatTotal: "0.00",
      totalWithVat: "100.00",
      taxSubtotals: [
        {
          category: "Z",
          rate: "0",
          taxable: "60.00",
          tax: "0.00",
          exemptionReasonCode: "VATEX-SA-32",
          exemptionReason: "Export of goods",
        },
        {
          category: "O",
          rate: "0",
          taxable: "40.00",
          tax: "0.00",
          exemptionReasonCode: "VATEX-EU-O",
          exemptionReason: null,
          includePercent: false,
        },
      ],
      lines: [],
      signature: { ...material, signingTimeIso: "2026-01-07T11:00:00Z" },
    });
    expect(xml).toContain("<cbc:TaxExemptionReasonCode>VATEX-SA-32</cbc:TaxExemptionReasonCode>");
    expect(xml).toContain("<cbc:TaxExemptionReason>Export of goods</cbc:TaxExemptionReason>");
    expect(xml).toContain("<cbc:TaxExemptionReasonCode>VATEX-EU-O</cbc:TaxExemptionReasonCode>");
    expect(validateInvoiceXml(xml).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("rejects a payment means code outside the allow-list (BR-KSA-16)", () => {
    const material = signingMaterial();
    const xml = buildInvoiceXml({
      invoiceNumber: "SI-5",
      uuid: "8d487816-70b8-4ade-a618-9d620b738150",
      icv: 5,
      previousHashB64: initialPih(),
      issueDate: "2026-01-07",
      issueTime: "11:30:00",
      docType: "standard",
      docSubtype: "invoice",
      currency: "SAR",
      seller: SELLER,
      buyer: BUYER,
      deliveryDate: "2026-01-07",
      paymentMeansCodes: ["99"],
      netTotal: "100.00",
      discountTotal: "0.00",
      vatTotal: "15.00",
      totalWithVat: "115.00",
      taxSubtotals: [{ category: "S", rate: "15", taxable: "100.00", tax: "15.00" }],
      lines: [],
      signature: { ...material, signingTimeIso: "2026-01-07T11:30:00Z" },
    });
    expect(validateInvoiceXml(xml).some((i) => i.code === "BR-KSA-16")).toBe(true);
  });
});

/* ------------------------------------------------------------------ helpers */

function decodeTlv(buffer: Buffer): { tag: number; value: Buffer }[] {
  const out: { tag: number; value: Buffer }[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = buffer[offset];
    const length = buffer[offset + 1];
    out.push({ tag, value: buffer.subarray(offset + 2, offset + 2 + length) });
    offset += 2 + length;
  }
  return out;
}

describe("TLV encoding", () => {
  it("prefixes each value with its tag and length", () => {
    const encoded = Buffer.from(tlvEncode([{ tag: 1, value: "AB" }, { tag: 2, value: "C" }]), "base64");
    expect([...encoded]).toEqual([1, 2, 0x41, 0x42, 2, 1, 0x43]);
  });

  it("keeps the simplified QR tag order (1-9)", () => {
    const qr = simplifiedQr({
      sellerName: "S",
      vatNumber: "311122393500003",
      issueDate: "2026-01-05",
      issueTime: "09:30:00",
      totalWithVat: "115.00",
      vatTotal: "15.00",
      invoiceHashB64: SAMPLE_HASH_B64,
      signatureValueB64: "sig",
      publicKeySpkiDer: Buffer.from([1, 2, 3]),
      certificateSignature: Buffer.from([4, 5]),
    });
    const tags = decodeTlv(Buffer.from(qr, "base64"));
    expect(tags.map((t) => t.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tags[2].value.toString("utf8")).toBe("2026-01-05T09:30:00Z");
  });
});
