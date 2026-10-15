/**
 * Local EGS certificate authority for the dev/test transport boundary.
 *
 * The mock transport must never fabricate a "signature valid" story: instead of
 * returning opaque tokens, it issues a REAL self-signed X.509 certificate for
 * the CSR that was submitted. Invoices are then signed with the EGS private key
 * and verified against that certificate, so onboarding → signing → submission
 * exercises genuine cryptography locally.
 *
 * This is explicitly NOT a ZATCA certificate and may only be produced while the
 * mock transport is gated on (ZATCA_TRANSPORT=mock or NODE_ENV=test).
 */

import { randomBytes, sign as nodeSign } from "node:crypto";
import { parseCsrParts } from "./csr";
import {
  OID,
  derBitString,
  derBoolean,
  derInt,
  derOctet,
  derOid,
  derPrintable,
  derSeq,
  derSet,
  derTag,
} from "./der";

export interface IssuedCertificate {
  /** base64 DER — the shape ZATCA returns as `binarySecurityToken` */
  certificateBase64: string;
  requestId: string;
  serial: string;
  notAfter: Date;
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return derTag(0x17, Buffer.from(text, "ascii"));
}

/** RDN ::= SET OF AttributeTypeAndValue (the SET is required — X.509 rejects a bare SEQUENCE). */
function rdn(oid: string, value: string): Buffer {
  return derSet(derSeq(derOid(oid), derPrintable(value)));
}

/** Self-sign a certificate for the CSR's subject + public key (1-year validity). */
export function issueLocalCertificate(input: {
  privateKeyPem: string;
  csrDer: Buffer;
  issuerCommonName: string;
}): IssuedCertificate {
  const { subjectDer, spkiDer } = parseCsrParts(input.csrDer);

  const serialBytes = randomBytes(8);
  serialBytes[0] &= 0x7f; // keep the INTEGER positive
  const serialNumber = BigInt(`0x${serialBytes.toString("hex")}`);

  const now = new Date();
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600 * 1000);

  const issuerName = derSeq(rdn(OID.countryName, "SA"), rdn(OID.commonName, input.issuerCommonName));

  const extensions = derTag(
    0xa3,
    derSeq(
      derSeq(derOid("2.5.29.19"), derBoolean(true), derOctet(derSeq(derBoolean(false)))),
      derSeq(
        derOid("2.5.29.15"),
        derBoolean(true),
        // digitalSignature | contentCommitment | keyEncipherment
        derOctet(derBitString(Buffer.from([0xe0]), 5)),
      ),
      derSeq(derOid(OID.certificateTemplateName), derOctet(derPrintable(input.issuerCommonName))),
    ),
  );

  const tbsCertificate = derSeq(
    derTag(0xa0, derInt(2)), // [0] EXPLICIT version v3
    derInt(serialNumber),
    derSeq(derOid(OID.ecdsaWithSha256)),
    issuerName,
    derSeq(utcTime(now), utcTime(notAfter)),
    subjectDer,
    spkiDer,
    extensions,
  );

  const signature = nodeSign("sha256", tbsCertificate, { key: input.privateKeyPem, format: "pem" });
  const certificate = derSeq(
    tbsCertificate,
    derSeq(derOid(OID.ecdsaWithSha256)),
    derBitString(signature),
  );

  return {
    certificateBase64: certificate.toString("base64"),
    requestId: randomBytes(16).toString("hex").slice(0, 24),
    serial: serialNumber.toString(),
    notAfter,
  };
}
