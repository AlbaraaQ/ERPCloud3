/**
 * ZATCA EGS CSR generation (FATOORA onboarding step 1).
 *
 * The CSR is built exactly per the official SDK's `Configuration.cnf` template
 * (secp256k1 key; C/OU/O/CN subject; `certificateTemplateName` extension OID
 * 1.3.6.1.4.1.311.20.2 with the environment-specific template value; and a
 * `subjectAltName` directoryName carrying SN, UID, title, registeredAddress,
 * businessCategory). The produced CSR is sent to the FATOORA compliance
 * endpoint as a single-line base64 string — never PEM with line breaks.
 *
 * Environment template values (official onboarding guidance):
 *   developer-portal (sandbox) → TSTZATCA-Code-Signing
 *   simulation                 → PREZATCA-Code-Signing
 *   core (production)          → ZATCA-Code-Signing
 */

import {
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import {
  OID,
  derBitString,
  derBoolean,
  derChild,
  derContext,
  derDecode,
  derInt,
  derOid,
  derOidToString,
  derOctet,
  derPrintable,
  derSeq,
  derSet,
  derUtf8,
  type DerNode,
} from "./der";

export type ZatcaEnv = "developer-portal" | "simulation" | "core";

export const CSR_TEMPLATE_NAME: Record<ZatcaEnv, string> = {
  "developer-portal": "TSTZATCA-Code-Signing",
  simulation: "PREZATCA-Code-Signing",
  core: "ZATCA-Code-Signing",
};

/**
 * Invoice-type flags for the CSR `title` field (TSCZ positions:
 * Tax, Simplified, future, future). "1100" = the EGS issues both standard and
 * simplified documents — what this product requires.
 */
export const INVOICE_TYPE_BOTH = "1100";

export interface CsrInput {
  env: ZatcaEnv;
  /** EGS serial number: `1-<solution>|2-<model/version>|3-<uuid v4>` */
  egsSerialNumber: string;
  /** 15 digits, starts and ends with 3 */
  vatNumber: string;
  organizationName: string;
  organizationalUnitName: string;
  /** defaults to the EGS serial number; simulation/sandbox get a documented prefix */
  commonName?: string;
  registeredAddress: string;
  businessCategory: string;
  invoiceType?: string;
  country?: string;
}

export interface CsrResult {
  privateKeyPem: string;
  publicKeySpkiPem: string;
  /** raw uncompressed EC point (0x04 || X || Y) — 65 bytes for secp256k1 */
  publicKeyRaw: Buffer;
  csrPem: string;
  csrDer: Buffer;
  /**
   * Single-line base64 handed to the compliance endpoint. Matches the official
   * SDK's `generated-csr-*.csr` file format: base64 of the PEM text (no line
   * breaks, no spaces). `csrDerBase64` is provided for gateways that require
   * base64 of the raw DER instead.
   */
  csrBase64: string;
  csrDerBase64: string;
  templateName: string;
  commonName: string;
}

function assertVatNumber(vat: string): void {
  if (!/^3\d{13}3$/.test(vat)) {
    throw new Error(
      `VAT registration number must be 15 digits starting and ending with 3 (got "${vat}")`,
    );
  }
}

/** JSON keyed attribute: SEQUENCE { OID, SET { value } } */
function attr(oid: string, value: Buffer): Buffer {
  return derSeq(derOid(oid), derSet(value));
}

/**
 * RDN: SET { SEQUENCE { OID, value } } — the value is encoded *directly* (no
 * nested SET). Mirrors the SDK/OpenSSL CSR: countryName as PrintableString,
 * every other attribute as UTF8String.
 */
function name(parts: { oid: string; value: string; printable?: boolean }[]): Buffer {
  return derSeq(
    ...parts.map((p) =>
      derSet(derSeq(derOid(p.oid), p.printable ? derPrintable(p.value) : derUtf8(p.value))),
    ),
  );
}

function extension(oid: string, der: Buffer, critical = false): Buffer {
  return derSeq(
    derOid(oid),
    ...(critical ? [derBoolean(true)] : []),
    derOctet(der),
  );
}

function defaultCommonName(input: CsrInput): string {
  if (input.commonName) return input.commonName;
  if (input.env === "simulation") return `PRE-${input.egsSerialNumber}`;
  if (input.env === "developer-portal") return `TST-${input.egsSerialNumber}`;
  return input.egsSerialNumber;
}

/**
 * Generate the EGS key pair (secp256k1) + CSR. The private key stays local; the
 * CSR is what gets signed by ZATCA into the CSID certificate.
 */
export function generateCsr(input: CsrInput): CsrResult {
  assertVatNumber(input.vatNumber);
  if (!input.egsSerialNumber || input.egsSerialNumber.length < 8) {
    throw new Error("EGS serial number is required (format 1-…|2-…|3-…)");
  }
  const country = input.country ?? "SA";
  const invoiceType = input.invoiceType ?? INVOICE_TYPE_BOTH;
  const commonName = defaultCommonName(input);
  const templateName = CSR_TEMPLATE_NAME[input.env];

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeySpkiPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const publicKeyRaw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);

  /* subject: C, OU, O, CN (SDK [dn] order) */
  const subject = name([
    { oid: OID.countryName, value: country, printable: true },
    { oid: OID.organizationalUnitName, value: input.organizationalUnitName },
    { oid: OID.organizationName, value: input.organizationName },
    { oid: OID.commonName, value: commonName },
  ]);

  /* subjectAltName → directoryName (GeneralName [4]) */
  const directoryName = name([
    { oid: OID.surname, value: input.egsSerialNumber },
    { oid: OID.userId, value: input.vatNumber },
    { oid: OID.title, value: invoiceType },
    { oid: OID.registeredAddress, value: input.registeredAddress },
    { oid: OID.businessCategory, value: input.businessCategory },
  ]);
  const sanValue = derSeq(derContext(4, directoryName));

  const extensions = derSeq(
    extension(OID.certificateTemplateName, derPrintable(templateName)),
    extension(OID.subjectAltName, sanValue),
  );

  /* SubjectPublicKeyInfo (id-ecPublicKey + secp256k1) */
  const spki = derSeq(
    derSeq(derOid(OID.ecPublicKey), derOid(OID.secp256k1)),
    derBitString(publicKeyRaw),
  );

  // attributes [0] IMPLICIT SET OF Attribute → the tag replaces SET; the
  // context node's content is the Attribute SEQUENCE(s) directly (an extra
  // wrapper here would make OpenSSL/ZATCA fail to read the extensions).
  const attributes = derContext(
    0,
    derSeq(derOid(OID.extensionRequest), derSet(extensions)),
  );

  const certificationRequestInfo = derSeq(
    derInt(0),
    subject,
    spki,
    attributes,
  );

  const signature = nodeSign("sha256", certificationRequestInfo, {
    key: privateKeyPem,
    format: "pem",
  });

  const csrDer = derSeq(
    certificationRequestInfo,
    derSeq(derOid(OID.ecdsaWithSha256)),
    derBitString(signature),
  );

  const csrPem = derToPem(csrDer, "CERTIFICATE REQUEST");

  return {
    privateKeyPem,
    publicKeySpkiPem,
    publicKeyRaw,
    csrPem,
    csrDer,
    csrBase64: Buffer.from(csrPem, "utf8").toString("base64"),
    csrDerBase64: csrDer.toString("base64"),
    templateName,
    commonName,
  };
}

/** Raw DER pieces of a CSR needed to mirror it into a certificate. */
export function parseCsrParts(csrDer: Buffer): { subjectDer: Buffer; spkiDer: Buffer } {
  const root = derDecode(csrDer);
  const info = derChild(root, 0x30, 0);
  if (!info) throw new Error("CSR structure invalid");
  const subject = derChild(info, 0x30, 0);
  const spki = derChild(info, 0x30, 1);
  if (!subject || !spki) throw new Error("CSR subject/public key missing");
  return { subjectDer: subject.raw, spkiDer: spki.raw };
}

export function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * Accept the three encodings seen in the wild (SDK base64-of-PEM, raw DER,
 * PEM text, base64-of-DER) and return the DER bytes.
 */
export function decodeCsrInput(input: string | Buffer): Buffer {
  if (Buffer.isBuffer(input)) {
    return input.subarray(0, 1)[0] === 0x30 ? input : decodeCsrInput(input.toString("utf8"));
  }
  const text = input.trim();
  if (text.includes("-----BEGIN")) return pemToDer(text);
  const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64");
  if (decoded.subarray(0, 1)[0] === 0x30) return decoded; // base64 of DER
  return pemToDer(decoded.toString("utf8")); // base64 of PEM (SDK file format)
}

export function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

/**
 * Verify a CSR the way the platform would before accepting it: DER structure,
 * subject/alt-name contents, template value, and the ECDSA signature over
 * CertificationRequestInfo using the embedded public key.
 */
export function inspectCsr(csrDer: Buffer): {
  commonName: string | null;
  organizationName: string | null;
  organizationalUnitName: string | null;
  countryName: string | null;
  templateName: string | null;
  altNames: Record<string, string>;
  signatureValid: boolean;
} {
  const root = derDecode(csrDer);
  const info = derChild(root, 0x30, 0);
  const sigAlgorithm = derChild(root, 0x30, 1);
  const signature = derChild(root, 0x03, 0);
  if (!info || !sigAlgorithm || !signature) throw new Error("CSR structure invalid");

  const subject = derChild(info, 0x30, 0);
  const spki = derChild(info, 0x30, 1);
  if (!spki) throw new Error("CSR subject public key missing");
  const readName = (n: DerNode | null): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const rdn of n?.children ?? []) {
      const a = rdn.children[0];
      if (!a) continue;
      const oid = derOidToString(a.children[0].content);
      const holder = a.children[1];
      const value = (holder.children[0] ?? holder).content.toString("utf8");
      out[oid] = value;
    }
    return out;
  };

  const subj = readName(subject);
  const altNames: Record<string, string> = {};
  let templateName: string | null = null;
  const attributes = info.children.find((c) => c.tag === 0xa0);
  for (const a of attributes?.children ?? []) {
    const oid = derOidToString(a.children[0].content);
    if (oid !== OID.extensionRequest) continue;
    const extensions = a.children[1].children[0];
    for (const ext of extensions.children) {
      const extOid = derOidToString(ext.children[0].content);
      const value = ext.children[ext.children.length - 1].content;
      if (extOid === OID.certificateTemplateName) {
        // extnValue is an OCTET STRING wrapping the actual DER value
        const inner = value.length > 0 && value[0] === 0x13 ? value : derDecode(value).raw;
        templateName = inner.subarray(2).toString("ascii");
      }
      if (extOid === OID.subjectAltName) {
        // GeneralNames SEQ → GeneralName [4] directoryName → Name SEQ
        const generalNames = derDecode(value);
        const dir = generalNames.children[0]?.children[0] ?? null;
        Object.assign(altNames, readName(dir));
      }
    }
  }

  // Node rejects JWK imports for secp256k1; the SPKI DER round-trips cleanly.
  const publicKey = createPublicKey({ key: spki.raw, format: "der", type: "spki" });
  const signatureValid = (() => {
    try {
      return nodeVerify("sha256", info.raw, publicKey, signature.content.subarray(1));
    } catch {
      return false;
    }
  })();

  return {
    commonName: subj[OID.commonName] ?? null,
    organizationName: subj[OID.organizationName] ?? null,
    organizationalUnitName: subj[OID.organizationalUnitName] ?? null,
    countryName: subj[OID.countryName] ?? null,
    templateName,
    altNames,
    signatureValid,
  };
}

export { createPublicKey };
