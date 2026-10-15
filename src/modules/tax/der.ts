/**
 * Minimal DER (ASN.1) reader/writer used for ZATCA certificate material.
 *
 * Why hand-rolled: the CSR must be generated exactly the way ZATCA's official
 * SDK (OpenSSL `Configuration.cnf`) generates it — secp256k1 key, the Microsoft
 * `certificateTemplateName` extension (OID 1.3.6.1.4.1.311.20.2) and a
 * `subjectAltName` directoryName carrying SN/UID/title/registeredAddress/
 * businessCategory. No available Node library emits custom-OID EC CSRs with
 * secp256k1, so the encoding is explicit here (and verified against the output
 * by tests using an independent ASN.1 parser).
 */

/* ------------------------------------------------------------------ writer */
export function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

export const derSeq = (...parts: Buffer[]): Buffer => derTag(0x30, Buffer.concat(parts));
export const derSet = (...parts: Buffer[]): Buffer => derTag(0x31, Buffer.concat(parts));
export const derNull = (): Buffer => Buffer.from([0x05, 0x00]);

export function derInt(value: number | bigint): Buffer {
  let v = typeof value === "bigint" ? value : BigInt(value);
  const negative = v < 0n;
  if (negative) v = -v;
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  if (bytes[0] & 0x80) bytes.unshift(negative ? 0xff : 0x00);
  else if (bytes[0] === 0x00 && bytes.length > 1) bytes.shift();
  return derTag(0x02, Buffer.from(bytes));
}

export function derBoolean(value: boolean): Buffer {
  return derTag(0x01, Buffer.from([value ? 0xff : 0x00]));
}

export function derOctet(bytes: Buffer): Buffer {
  return derTag(0x04, bytes);
}

export function derBitString(bytes: Buffer, unusedBits = 0): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

export const derUtf8 = (s: string): Buffer => derTag(0x0c, Buffer.from(s, "utf8"));
export const derPrintable = (s: string): Buffer => derTag(0x13, Buffer.from(s, "ascii"));

/** context-specific, constructed (0xa0 | n) — e.g. directoryName [4]. */
export const derContext = (n: number, content: Buffer): Buffer => derTag(0xa0 | n, content);

export function derOid(oid: string): Buffer {
  const parts = oid.split(".").map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new Error(`invalid OID: ${oid}`);
  }
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack: number[] = [part & 0x7f];
    let v = part >>> 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(...stack);
  }
  return derTag(0x06, Buffer.from(out));
}

/* ------------------------------------------------------------------ reader */
export interface DerNode {
  tag: number;
  /** raw content bytes (without tag/length) */
  content: Buffer;
  /** the whole node including tag/length */
  raw: Buffer;
  children: DerNode[];
}

/** Parse one DER node at `offset`; returns the node and the next offset. */
export function derRead(buf: Buffer, offset = 0): { node: DerNode; next: number } {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 2 + i];
    headerLen = 2 + n;
  }
  const start = offset + headerLen;
  const content = buf.subarray(start, start + len);
  const node: DerNode = {
    tag,
    content,
    raw: buf.subarray(offset, start + len),
    children: [],
  };
  // constructed containers: recurse
  if ((tag & 0x20) !== 0) {
    let i = 0;
    while (i < content.length) {
      const child = derRead(content, i);
      node.children.push(child.node);
      i = child.next;
    }
  }
  return { node, next: start + len };
}

export function derDecode(buf: Buffer): DerNode {
  return derRead(buf, 0).node;
}

/** Find a child by tag; `index` selects the Nth match. */
export function derChild(parent: DerNode, tag: number, index = 0): DerNode | null {
  return parent.children.filter((c) => c.tag === tag)[index] ?? null;
}

export function derOidToString(content: Buffer): string {
  const first = content[0];
  const arcs: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const byte of content.subarray(1)) {
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
}

/* ------------------------------------------------- named ZATCA OIDs/constants */
export const OID = {
  /** Microsoft certificate template extension used by ZATCA's CSR template. */
  certificateTemplateName: "1.3.6.1.4.1.311.20.2",
  subjectAltName: "2.5.29.17",
  extensionRequest: "1.2.840.113549.1.9.14",
  ecPublicKey: "1.2.840.10045.2.1",
  secp256k1: "1.3.132.0.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  surname: "2.5.4.4",
  userId: "0.9.2342.19200300.100.1.1",
  title: "2.5.4.12",
  registeredAddress: "2.5.4.26",
  businessCategory: "2.5.4.15",
  countryName: "2.5.4.6",
  organizationName: "2.5.4.10",
  organizationalUnitName: "2.5.4.11",
  commonName: "2.5.4.3",
} as const;

export const NAME_LABEL: Record<string, string> = {
  [OID.countryName]: "C",
  [OID.organizationName]: "O",
  [OID.organizationalUnitName]: "OU",
  [OID.commonName]: "CN",
  [OID.surname]: "SN",
  [OID.userId]: "UID",
  [OID.title]: "title",
  [OID.registeredAddress]: "registeredAddress",
  [OID.businessCategory]: "businessCategory",
};
