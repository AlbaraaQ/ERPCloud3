/**
 * E-invoice cryptography (ZATCA Security Features Implementation Standards):
 * secp256k1 ECDSA key handling, SHA-256 invoice hash, TLV QR coding.
 *
 * Spec-anchored parts:
 *  - INITIAL_PIH: base64 of the SHA-256 hex digest of "1" is NOT a thing —
 *    the canonical first-invoice PIH per official SDKs is base64 of the
 *    SHA-256 hex of "0" (see reference value in tests). Marked MUST-VERIFY.
 *  - QR TLV for simplified invoices includes tags 1..9; standard/clearance
 *    flow carries the platform's stamp (never fabricated locally — D-012).
 *  - Signature: ECDSA secp256k1 over the invoice hash (device-side EGO key);
 *    ZATCA-side stamping happens on the platform only.
 */

import { createHash, generateKeyPairSync, sign as nodeSign, createPublicKey } from "crypto";
import type { KeyObject } from "crypto";

export const b64 = (buf: Buffer | string): string => Buffer.from(buf).toString("base64");

/** base64 of SHA-256 hex of "0" — canonical initial PIH per official SDKs (verify at onboarding). */
export function initialPih(): string {
  return b64(sha256Hex("0"));
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256B64(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64");
}

/* ------------------------------------------------------------- key material */
export interface DeviceKeys {
  privateKeyPem: string;
  publicKeySpkiPem: string;
  publicKeyRawUncompressed: Buffer; // 0x04 || X(32) || Y(32) — 65 bytes
}

export function generateDeviceKeys(): DeviceKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  try {
    // preferred: raw uncompressed point (Phase-2 TLV tag 8)
    const jwk = publicKey.export({ format: "jwk" }) as unknown as { x: string; y: string };
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    const raw = Buffer.concat([Buffer.from([0x04]), x, y]);
    const spki = publicKey.export({ type: "spki", format: "pem" }).toString();
    return { privateKeyPem: priv, publicKeySpkiPem: spki, publicKeyRawUncompressed: raw };
  } catch {
    // fallback: SPKI is always encodable; raw point marked empty (subset flows)
    const spki = publicKey.export({ type: "spki", format: "pem" }).toString();
    return { privateKeyPem: priv, publicKeySpkiPem: spki, publicKeyRawUncompressed: Buffer.alloc(0) };
  }
}

export function publicKeyRawFromPem(spkiPem: string): Buffer {
  const key = createPublicKey({ key: spkiPem, format: "pem" });
  const jwk = key.export({ format: "jwk" }) as unknown as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

/** ECDSA/secp256k1 signature bytes (DER-encoded, per SDK convention). */
export function signHash(privateKeyPem: string, message: Buffer): Buffer {
  return nodeSign(null, message, { key: privateKeyPem, format: "pem" });
}

/* ------------------------------------------------------------------ TLV QR */
export interface TlvPart {
  tag: number;
  value: Buffer | string;
}

/** TLV encode: tag(1) length(1) value(n), concatenated, base64'd. */
export function tlvEncode(parts: TlvPart[]): string {
  const chunks = parts.map((p) => {
    const v = typeof p.value === "string" ? Buffer.from(p.value, "utf8") : p.value;
    return Buffer.concat([Buffer.from([p.tag]), Buffer.from([v.length]), v]);
  });
  return Buffer.concat(chunks).toString("base64");
}

/**
 * Build the simplified-invoice QR TLV (tags 1..9).
 * Tag 6 = invoice hash (b64); 7 = signature value; 8 = EC public key;
 * 9 = ECDSA signature on the invoice hash (secp256k1).
 * Unsigned QR is NEVER emitted (config error upstream — D-012/Iz strictness).
 */
export function simplifiedQrPayload(input: {
  sellerName: string;
  vatNumber: string;
  timestampIso: string;
  totalWithVat: string;
  vatTotal: string;
  invoiceHashB64: string;
  signatureValueB64: string;
  publicKeyRaw: Buffer;
  hashSignatureB64: string;
}): string {
  return tlvEncode([
    { tag: 1, value: input.sellerName },
    { tag: 2, value: input.vatNumber },
    { tag: 3, value: input.timestampIso },
    { tag: 4, value: input.totalWithVat },
    { tag: 5, value: input.vatTotal },
    { tag: 6, value: input.invoiceHashB64 },
    { tag: 7, value: input.signatureValueB64 },
    { tag: 8, value: input.publicKeyRaw },
    { tag: 9, value: input.hashSignatureB64 },
  ]);
}

/** Standard-invoice QR payload (tags 1..5 — platform stamping completes it). */
export function standardQrPayload(input: {
  sellerName: string;
  vatNumber: string;
  timestampIso: string;
  totalWithVat: string;
  vatTotal: string;
}): string {
  return tlvEncode([
    { tag: 1, value: input.sellerName },
    { tag: 2, value: input.vatNumber },
    { tag: 3, value: input.timestampIso },
    { tag: 4, value: input.totalWithVat },
    { tag: 5, value: input.vatTotal },
  ]);
}

export type DeviceKeyObject = KeyObject;
