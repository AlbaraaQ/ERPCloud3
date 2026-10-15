/**
 * ZATCA invoice signature & hash layer (XAdES-BES enveloped, XMLDSig).
 *
 * Verified against the official SDK sample (Data/Samples/…/Simplified_Invoice.xml):
 * canonicalizing the invoice with UBLExtensions, cac:Signature and the QR
 * AdditionalDocumentReference removed and hashing it with SHA-256 reproduces the
 * sample's ds:DigestValue byte-for-byte (see tests/unit/zatca-hash.test.ts, which
 * embeds that sample as a fixture).
 *
 * Encoding conventions (all confirmed against SDK artifacts):
 *  - invoice reference DigestValue / QR tag 6 / API `invoiceHash` → base64 of the
 *    raw 32-byte SHA-256 digest;
 *  - XAdES CertDigest and SignedProperties reference DigestValue → base64 of the
 *    *hex* digest text (the SDK's double encoding);
 *  - PIH genesis (BR-KSA-26) → base64 of the hex digest of "0";
 *  - QR tag 8 → raw SPKI DER bytes; tag 9 → the certificate's own signature bytes;
 *  - QR tag 3 → "<IssueDate>T<IssueTime>Z" (same clock as the XML, Z suffix, as
 *    the SDK emits).
 * ZATCA's portal compliance checks remain the final arbiter (D-012).
 */

import {
  createHash,
  createPrivateKey,
  sign as nodeSign,
  verify as nodeVerify,
  X509Certificate,
} from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { C14nCanonicalization } from "xml-crypto";
import { derChild, derDecode } from "./der";

export const C14N11 = "http://www.w3.org/2006/12/xml-c14n11";
export const SIG_ECDSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";
export const DIGEST_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";

const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const XADES_NS = "http://uri.etsi.org/01903/v1.3.2#";

export interface CanonicalParts {
  /** the document without UBLExtensions, cac:Signature and the QR reference */
  stripped: string;
  c14n: string;
  /** hex digest of the canonical form */
  hex: string;
  /** base64 of the raw digest bytes — API `invoiceHash`, QR tag 6, PIH value */
  b64: string;
}

function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, "text/xml");
}

/** true when the parsed document reported errors (xmldom is lenient by default). */
export function isWellFormed(xml: string): boolean {
  let error: string | null = null;
  const doc = new DOMParser({
    onError: (_level, message) => {
      error ??= message;
    },
  }).parseFromString(xml, "text/xml");
  return !error && doc.documentElement?.nodeName === "Invoice";
}

/**
 * Remove the three node families excluded by ZATCA's XPath transforms, then
 * canonicalize (the SDK declares c14n11; for these documents the 1.0 canonical
 * form used here is identical — proven by the SDK sample fixture test).
 */
export function canonicalizeForHash(xml: string): CanonicalParts {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root) throw new Error("invoice XML has no root element");

  const remove = (nodes: unknown[]) => {
    for (const n of nodes) {
      const node = n as { parentNode?: { removeChild: (c: unknown) => void } };
      if (node?.parentNode) node.parentNode.removeChild(node);
    }
  };
  const all = (name: string) =>
    Array.from(root.getElementsByTagName(name) as unknown as unknown[]);

  remove(all("ext:UBLExtensions"));
  remove(all("cac:Signature"));
  remove(
    all("cac:AdditionalDocumentReference").filter((r) => {
      const ids = (r as { getElementsByTagName: (n: string) => unknown }).getElementsByTagName(
        "cbc:ID",
      ) as unknown as { textContent: string | null }[];
      return (ids[0]?.textContent ?? "").trim() === "QR";
    }),
  );

  const canonicalizer = new C14nCanonicalization();
  const c14n = canonicalizer.process(root as never, {});
  const hex = createHash("sha256").update(c14n, "utf8").digest("hex");
  return {
    stripped: c14n,
    c14n,
    hex,
    b64: Buffer.from(hex, "hex").toString("base64"),
  };
}

/** SHA-256 helpers in both encodings (see conventions above). */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function sha256B64Raw(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64");
}
export function sha256B64Double(value: string | Buffer): string {
  return Buffer.from(sha256Hex(value), "utf8").toString("base64");
}
/** BR-KSA-26 initial PIH: base64 of the hex digest of "0". */
export function initialPih(): string {
  return sha256B64Double("0");
}

/** Depth-first search by local name (xmldom matches the qualified name otherwise). */
function findByLocalName(xml: string, localName: string) {
  const doc = parseXml(xml);
  const walk = (node: { nodeType?: number; localName?: string; childNodes?: unknown[] }): unknown => {
    if (node.nodeType === 1 && node.localName === localName) return node;
    for (const child of (node.childNodes ?? []) as { nodeType?: number; localName?: string; childNodes?: unknown[] }[]) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const root = doc.documentElement as unknown as { nodeType?: number; localName?: string; childNodes?: unknown[] };
  const node = walk(root);
  if (!node) throw new Error(`element ${localName} not found`);
  return node;
}

/** Canonicalize a single element as it appears inside its document. */
export function canonicalizeElement(xml: string, localName: string, ns?: string): string {
  const doc = parseXml(xml);
  const node =
    (ns ? doc.getElementsByTagNameNS(ns, localName)[0] : undefined) ??
    doc.getElementsByTagName(localName)[0] ??
    findByLocalName(xml, localName);
  if (!node) throw new Error(`element ${localName} not found`);
  const canonicalizer = new C14nCanonicalization();
  return canonicalizer.process(node as never, {});
}

export interface CertificateInfo {
  /** SPKI DER of the EGS public key — QR tag 8 */
  /** base64 DER exactly as returned by ZATCA (`binarySecurityToken`) */
  base64Der: string;
  der: Buffer;
  /** base64 of the hex digest of the DER — XAdES CertDigest */
  certDigestB64: string;
  /** X.509 signature value bytes (QR tag 9) */
  signatureValue: Buffer;
  publicKeySpkiDer: Buffer;
  serialNumberDecimal: string;
  issuerName: string;
  notAfter: Date;
  publicKeyPem: string;
}

/**
 * Read the pieces XAdES/QR need straight from the certificate. The signature
 * value and serial come from the DER so nothing depends on Node's string
 * formatting of distinguished names.
 */
export function inspectCertificate(certificateB64Der: string): CertificateInfo {
  const der = Buffer.from(certificateB64Der.trim(), "base64");
  const cert = new X509Certificate(der);

  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }
  const root = derDecode(der);
  const signatureBitString = derChild(root, 0x03, 0);
  if (!signatureBitString) throw new Error("certificate signature missing");
  const signatureValue = signatureBitString.content.subarray(1); // drop unused-bits byte

  // tbsCertificate: [0] version?, serialNumber, signature, issuer, …
  const tbs = derChild(root, 0x30, 0);
  if (!tbs) throw new Error("certificate tbs missing");
  const serialNode = derChild(tbs, 0x02, tbs.children[0]?.tag === 0xa0 ? 0 : 0);
  const serialDecimal = serialNode ? BigInt(`0x${serialNode.content.toString("hex")}`).toString() : "0";
  const issuer = derChild(tbs, 0x30, tbs.children[0]?.tag === 0xa0 ? 1 : 0);

  const OID_HOST = "2.5.4.97"; // organizationIdentifier — printable like the rest
  const labelOf = (oid: string): string =>
    ({
      "2.5.4.3": "CN",
      "2.5.4.4": "SN",
      "2.5.4.5": "serialNumber",
      "2.5.4.6": "C",
      "2.5.4.7": "L",
      "2.5.4.8": "ST",
      "2.5.4.10": "O",
      "2.5.4.11": "OU",
      "2.5.4.12": "title",
      "2.5.4.15": "businessCategory",
      "2.5.4.17": "postalCode",
      "0.9.2342.19200300.100.1.1": "UID",
      "0.9.2342.19200300.100.1.25": "DC",
      [OID_HOST]: "organizationIdentifier",
    })[oid] ?? oid;

  // RFC 4514 (most specific first) — matches the SDK's X509IssuerName rendering
  const issuerName = (issuer?.children ?? [])
    .map((rdn) => {
      const a = rdn.children[0];
      if (!a) return "";
      const oid = a.children[0].content;
      const arcs: number[] = [Math.floor(oid[0] / 40), oid[0] % 40];
      let value = 0;
      for (const byte of oid.subarray(1)) {
        value = (value << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) {
          arcs.push(value);
          value = 0;
        }
      }
      const holder = a.children[1];
      const text = (holder.children[0] ?? holder).content.toString("utf8");
      return `${labelOf(arcs.join("."))}=${text}`;
    })
    .filter(Boolean)
    .reverse()
    .join(", ");

  return {
    base64Der: certificateB64Der.trim(),
    der,
    certDigestB64: sha256B64Double(der),
    signatureValue,
    publicKeySpkiDer: cert.publicKey.export({ type: "spki", format: "der" }) as Buffer,
    serialNumberDecimal: serialDecimal,
    issuerName,
    notAfter: cert.validTo ? new Date(cert.validTo) : new Date(0),
    publicKeyPem: cert.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export interface SignOptions {
  invoiceXml: string;
  certificateB64Der: string;
  privateKeyPem: string;
  /** ISO-8601 UTC instant used for xades:SigningTime */
  signingTimeIso: string;
}

export interface SignResult {
  /** the invoice XML with the finished UBLExtensions signature container */
  signedXml: string;
  /** full ds:Signature block (also embedded in the document) */
  signatureBlock: string;
  signatureValueB64: string;
  invoiceHashB64: string;
  invoiceHashHex: string;
  signedPropertiesDigestB64: string;
  certificate: CertificateInfo;
}

const PLACEHOLDER_SIGNATURE = "__ZATCA_SIGNATURE_VALUE__";
const PLACEHOLDER_SIGNED_PROPS = "__ZATCA_SIGNED_PROPERTIES_DIGEST__";

function signedPropertiesXml(cert: CertificateInfo, signingTimeIso: string): string {
  return `<xades:SignedProperties xmlns:xades="${XADES_NS}" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${signingTimeIso}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod Algorithm="${DIGEST_SHA256}"></ds:DigestMethod>
                                                    <ds:DigestValue>${cert.certDigestB64}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName>${escapeXml(cert.issuerName)}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber>${cert.serialNumberDecimal}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * XAdES-BES signature container, byte-shaped after the official template
 * (`xml/ubl.xml` inside the SDK jar) : ext:UBLExtensions → sig:UBLDocumentSignatures
 * → sac:SignatureInformation → ds:Signature with the three XPath transforms,
 * KeyInfo/X509Certificate and xades:QualifyingProperties.
 */
function signatureContainer(options: {
  certificate: CertificateInfo;
  signingTimeIso: string;
  invoiceHashB64: string;
}): string {
  const { certificate, signingTimeIso, invoiceHashB64 } = options;
  return `<ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2" xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature Id="signature" xmlns:ds="${DS_NS}">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="${C14N11}"></ds:CanonicalizationMethod>
                            <ds:SignatureMethod Algorithm="${SIG_ECDSA_SHA256}"></ds:SignatureMethod>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="${C14N11}"></ds:Transform>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="${DIGEST_SHA256}"></ds:DigestMethod>
                                <ds:DigestValue>${invoiceHashB64}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="${DIGEST_SHA256}"></ds:DigestMethod>
                                <ds:DigestValue>${PLACEHOLDER_SIGNED_PROPS}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>${PLACEHOLDER_SIGNATURE}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>${certificate.base64Der}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties Target="signature" xmlns:xades="${XADES_NS}">
                                ${signedPropertiesXml(certificate, signingTimeIso)}
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>`;
}

/**
 * Sign an invoice that already carries its `cac:Signature` + empty QR reference
 * and an `<ext:UBLExtensions/>` placeholder.
 *
 * Digest order matters and mirrors the SDK implementation
 * (`HashingGenerationServiceImpl`): the invoice reference digest is the SHA-256
 * of the canonicalized document (c14n11 — reproduced byte-for-byte by the
 * c14n 1.0 pass used here, see the fixture test), the SignedProperties digest is
 * taken over the canonicalized element *inside the document*, and SignedInfo is
 * canonicalized last so the ECDSA (secp256k1) signature covers the final bytes.
 * Both XAdES digests use the SDK's double encoding: base64 of the hex digest.
 */
export function signInvoice(options: SignOptions): SignResult {
  const { invoiceXml, privateKeyPem, signingTimeIso } = options;
  const certificate = inspectCertificate(options.certificateB64Der);

  const hash = canonicalizeForHash(invoiceXml);
  const container = signatureContainer({
    certificate,
    signingTimeIso,
    invoiceHashB64: hash.b64,
  });

  const embed = (value: string) =>
    invoiceXml.replace("<ext:UBLExtensions/>", `<ext:UBLExtensions>${value}</ext:UBLExtensions>`);

  // 1. digest of the canonicalized xades:SignedProperties (placeholder removed first)
  const withDigestPlaceholder = embed(container).replace(PLACEHOLDER_SIGNED_PROPS, "");
  const signedPropertiesC14n = canonicalizeElement(withDigestPlaceholder, "SignedProperties", XADES_NS);
  const signedPropertiesDigestB64 = sha256B64Double(signedPropertiesC14n);
  const withDigest = embed(container.replace(PLACEHOLDER_SIGNED_PROPS, signedPropertiesDigestB64));

  // 2. canonicalize SignedInfo and sign it
  const signedInfoC14n = canonicalizeElement(withDigest, "SignedInfo");
  const signatureValue = nodeSign("sha256", Buffer.from(signedInfoC14n, "utf8"), {
    key: createPrivateKey(privateKeyPem),
  });
  const signatureValueB64 = signatureValue.toString("base64");

  const finalContainer = container
    .replace(PLACEHOLDER_SIGNED_PROPS, signedPropertiesDigestB64)
    .replace(PLACEHOLDER_SIGNATURE, signatureValueB64);

  return {
    signedXml: embed(finalContainer),
    signatureBlock: finalContainer,
    signatureValueB64,
    invoiceHashB64: hash.b64,
    invoiceHashHex: hash.hex,
    signedPropertiesDigestB64,
    certificate,
  };
}

/**
 * Verify a signed invoice the way the platform's validator does:
 *  1. invoice reference DigestValue == sha256(canonicalized document, minus the
 *     UBLExtensions / cac:Signature / QR reference) base64(raw);
 *  2. xades:SignedProperties reference digest == base64(hex(c14n SignedProperties));
 *  3. xades:CertDigest == base64(hex(sha256(certificate DER)));
 *  4. ds:SignatureValue verifies over the canonicalized SignedInfo with the
 *     embedded certificate's public key.
 */
export function verifyInvoiceSignature(xml: string): {
  digestValid: boolean;
  signedPropertiesValid: boolean;
  certificateDigestValid: boolean;
  signatureValid: boolean;
  invoiceHashB64: string;
} {
  const doc = parseXml(xml);
  const references = Array.from(
    doc.getElementsByTagNameNS(DS_NS, "Reference") as unknown as {
      getAttribute: (n: string) => string | null;
      getElementsByTagNameNS: (ns: string, name: string) => { textContent: string | null }[];
    }[],
  );
  const digestOf = (predicate: (uri: string) => boolean): string => {
    for (const ref of references) {
      if (predicate(ref.getAttribute("URI") ?? "")) {
        return ref.getElementsByTagNameNS(DS_NS, "DigestValue")[0]?.textContent?.trim() ?? "";
      }
    }
    return "";
  };
  const invoiceReferenceDigest = digestOf((uri) => uri === "");
  const signedPropsDigest = digestOf((uri) => uri === "#xadesSignedProperties");

  const recalculated = canonicalizeForHash(xml);

  const signedProps = doc.getElementsByTagNameNS(XADES_NS, "SignedProperties")[0];
  const signedPropertiesValid =
    Boolean(signedProps) &&
    sha256B64Double(canonicalizeNode(signedProps)) === signedPropsDigest;

  const certB64 = doc.getElementsByTagNameNS(DS_NS, "X509Certificate")[0]?.textContent?.trim() ?? "";
  const declaredCertDigest = doc
    .getElementsByTagNameNS(XADES_NS, "CertDigest")[0]
    ?.getElementsByTagNameNS(DS_NS, "DigestValue")[0]?.textContent?.trim();
  let certificateDigestValid = false;
  let signatureValid = false;
  try {
    const der = Buffer.from(certB64, "base64");
    certificateDigestValid = Boolean(
      declaredCertDigest && sha256B64Double(der) === declaredCertDigest,
    );
    const signatureValueB64 =
      doc.getElementsByTagNameNS(DS_NS, "SignatureValue")[0]?.textContent?.trim() ?? "";
    const signedInfoC14n = canonicalizeElement(xml, "SignedInfo");
    const cert = new X509Certificate(der);
    signatureValid = nodeVerify(
      "sha256",
      Buffer.from(signedInfoC14n, "utf8"),
      cert.publicKey,
      Buffer.from(signatureValueB64, "base64"),
    );
  } catch {
    signatureValid = false;
  }

  return {
    digestValid: recalculated.b64 === invoiceReferenceDigest,
    signedPropertiesValid,
    certificateDigestValid,
    signatureValid,
    invoiceHashB64: recalculated.b64,
  };
}

/** Canonicalize a DOM node (used for the XAdES SignedProperties digest). */
function canonicalizeNode(node: unknown): string {
  const canonicalizer = new C14nCanonicalization();
  return canonicalizer.process(node as never, {});
}

/** Re-serialize a node so it can be re-parsed inside its namespace context. */
export function serializeNode(node: unknown): string {
  return new XMLSerializer().serializeToString(node as never);
}

/* ------------------------------------------------------------------ TLV QR */
export interface TlvPart {
  tag: number;
  value: Buffer | string;
}

export function tlvEncode(parts: TlvPart[]): string {
  const chunks = parts.map((p) => {
    const v = Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value, "utf8");
    if (v.length > 0xff) throw new Error(`TLV value too long for tag ${p.tag}`);
    return Buffer.concat([Buffer.from([p.tag, v.length]), v]);
  });
  return Buffer.concat(chunks).toString("base64");
}

/**
 * Simplified-invoice QR (tags 1–9). Tags 6–9 exist only for signed simplified
 * documents; a document without a real signature must never carry them (D-012).
 */
export function simplifiedQr(input: {
  sellerName: string;
  vatNumber: string;
  issueDate: string;
  issueTime: string;
  totalWithVat: string;
  vatTotal: string;
  invoiceHashB64: string;
  signatureValueB64: string;
  publicKeySpkiDer: Buffer;
  certificateSignature: Buffer;
}): string {
  return tlvEncode([
    { tag: 1, value: input.sellerName },
    { tag: 2, value: input.vatNumber },
    { tag: 3, value: `${input.issueDate}T${input.issueTime}Z` },
    { tag: 4, value: input.totalWithVat },
    { tag: 5, value: input.vatTotal },
    { tag: 6, value: input.invoiceHashB64 },
    { tag: 7, value: input.signatureValueB64 },
    { tag: 8, value: input.publicKeySpkiDer },
    { tag: 9, value: input.certificateSignature },
  ]);
}

/** Standard invoices carry the five clear-text tags before clearance. */
export function standardQr(input: {
  sellerName: string;
  vatNumber: string;
  issueDate: string;
  issueTime: string;
  totalWithVat: string;
  vatTotal: string;
}): string {
  return tlvEncode([
    { tag: 1, value: input.sellerName },
    { tag: 2, value: input.vatNumber },
    { tag: 3, value: `${input.issueDate}T${input.issueTime}Z` },
    { tag: 4, value: input.totalWithVat },
    { tag: 5, value: input.vatTotal },
  ]);
}
