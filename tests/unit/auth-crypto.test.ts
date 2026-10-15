/**
 * Auth crypto unit tests: Argon2id hashing and session token primitives (SEC §3).
 * These do not touch the database.
 */

import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
  tokensEqual,
} from "@/modules/identity/auth";

describe("password hashing (argon2id)", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("Hisab#2026");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "Hisab#2026")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("salts: same password → different hashes", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });
});

describe("session tokens", () => {
  it("tokens are url-safe, long, and unique", () => {
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    expect(t1).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(t1).not.toBe(t2);
  });

  it("hashToken is deterministic and token-independent of the raw value", () => {
    const t = generateSessionToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t.slice(0, 8));
  });

  it("tokensEqual constant-time comparison", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("abc", "abcd")).toBe(false);
  });
});
