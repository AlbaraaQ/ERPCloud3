/**
 * TOTP (RFC 6238) for platform-owner 2FA (PLATFORM_ADMIN §0: mandatory 2FA for Owner).
 *
 * Implemented directly on node:crypto — HMAC-SHA1, 30 s step, 6 digits, ±1 step
 * drift, constant-time comparison. Secrets are base32 (RFC 4648, no padding) as
 * every authenticator app expects, and stored encrypted (D-024).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit shared secret (RFC 4226 §4 recommendation for HMAC-SHA1). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for a specific counter/time. Exposed for tests and drift windows. */
export function totpAt(secretBase32: string, epochSeconds: number, digits = TOTP_DIGITS): string {
  const counter = Math.floor(epochSeconds / TOTP_STEP_SECONDS);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Current code (used by enrolment UI/tests; the server verifies, never trusts). */
export function currentTotp(secretBase32: string, now = Date.now()): string {
  return totpAt(secretBase32, Math.floor(now / 1000));
}

/**
 * Verify a submitted code with ±1 step tolerance (clock drift).
 * Comparison is constant-time; a malformed code is simply invalid.
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): boolean {
  const submitted = (code ?? "").replace(/\D/g, "");
  if (submitted.length !== TOTP_DIGITS) return false;
  const seconds = Math.floor(now / 1000);
  for (const drift of [-1, 0, 1]) {
    const expected = totpAt(secretBase32, seconds + drift * TOTP_STEP_SECONDS);
    const a = Buffer.from(expected);
    const b = Buffer.from(submitted);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator apps (Google Authenticator, 1Password, …). */
export function totpUri(opts: { secret: string; account: string; issuer?: string }): string {
  const issuer = opts.issuer ?? "Hisab ERP";
  const label = `${issuer}:${opts.account}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
