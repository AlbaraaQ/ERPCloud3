/**
 * Session token primitives (SEC §3) — Node-only, no Next.js imports so the
 * platform tier and tests can use them directly.
 *
 * The cookie holds a 256-bit random token; only its SHA-256 is stored.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cookie payload for comparisons (timing-safe where it matters). */
export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
