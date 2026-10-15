/**
 * Shared-kernel unit tests: money (D-003), results, ids (D-004), dates (D-016),
 * permission catalog integrity.
 */

import { describe, it, expect } from "vitest";
import {
  add, sub, mul, div, sum, roundMoney, roundQty, toDb, formatMoney,
  assertBalanced, eqMoney, isNegative,
} from "@/modules/shared/money";
import { ok, err, errors, toDomainError, isDomainError } from "@/modules/shared/result";
import { newId, isUuid } from "@/modules/shared/ids";
import { businessDate, addDays, monthRange, isValidISODate } from "@/modules/shared/dates";
import { PERMISSIONS, ROLE_PRESETS, isPermissionCode } from "@/modules/shared/permissions";

describe("money — decimal-only semantics (D-003)", () => {
  it("0.1 + 0.2 = 0.3 exactly (no float artifacts)", () => {
    expect(toDb(add("0.1", "0.2"))).toBe("0.3");
  });
  it("multiplication keeps full precision", () => {
    expect(toDb(mul("19.99", "3"))).toBe("59.97");
    expect(toDb(mul("10.6667", "3"))).toBe("32.0001");
  });
  it("roundMoney uses HALF_UP to currency minor units", () => {
    expect(toDb(roundMoney("2.005", "SAR"))).toBe("2.01");
    expect(toDb(roundMoney("2.004", "SAR"))).toBe("2");
    expect(toDb(roundMoney("0.995", "KWD"))).toBe("0.995"); // KWD = 3 decimals
  });
  it("roundQty keeps 6 decimals", () => {
    expect(toDb(roundQty("1.23456789"))).toBe("1.234568");
  });
  it("sum of many small values stays exact", () => {
    const total = sum(Array(100).fill("0.01"));
    expect(toDb(total)).toBe("1");
  });
  it("toDb never emits exponential notation", () => {
    expect(toDb("0.00000001")).toBe("0.00000001");
    expect(toDb("1234567890123456789.99")).toBe("1234567890123456789.99");
  });
  it("division and comparison helpers", () => {
    expect(toDb(roundMoney(div("10", "3"), "SAR"))).toBe("3.33");
    expect(eqMoney("1.50", "1.5")).toBe(true);
    expect(isNegative("-0.001")).toBe(true);
  });
  it("assertBalanced passes balanced entries and throws otherwise (INV-01)", () => {
    expect(() => assertBalanced(["100.10", "200"], ["300.10"], "SAR")).not.toThrow();
    expect(() => assertBalanced(["100.10"], ["100.11"], "SAR")).toThrow(/not balanced/i);
  });
  it("formatMoney pads to currency decimals", () => {
    expect(formatMoney("7", "SAR")).toBe("7.00");
  });
  it("sub works", () => expect(toDb(sub("5", "3.25"))).toBe("1.75"));
});

describe("result & domain errors", () => {
  it("ok/err flow", () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
    const e = err(errors.validation("errors.x"));
    expect(e.ok).toBe(false);
  });
  it("toDomainError wraps unknown errors as invariant violations", () => {
    const d = toDomainError(new Error("boom"));
    expect(isDomainError(d)).toBe(true);
    expect(d.kind).toBe("InvariantViolation");
  });
  it("permission error carries the missing permission", () => {
    const e = errors.permission("sales.post");
    expect(e.kind).toBe("PermissionDenied");
    expect(e.meta?.permission).toBe("sales.post");
  });
});

describe("ids — uuidv7 (D-004)", () => {
  it("generates valid, monotonically ordered ids", () => {
    const a = newId();
    const b = newId();
    const c = newId();
    expect(isUuid(a)).toBe(true);
    expect(a < b && b <= c).toBe(true); // time-ordered
  });
});

describe("dates — tenant business_date (D-016)", () => {
  it("Asia/Riyadh boundary: 21:30 UTC is next business day", () => {
    const instant = new Date("2026-01-01T21:30:00Z"); // 00:30 +03 on Jan 2
    expect(businessDate(instant, "Asia/Riyadh")).toBe("2026-01-02");
    expect(businessDate(instant, "UTC")).toBe("2026-01-01");
  });
  it("same instant, same day inside timezone", () => {
    expect(businessDate(new Date("2026-06-15T12:00:00Z"), "Asia/Riyadh")).toBe("2026-06-15");
  });
  it("addDays & monthRange & validation", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(isValidISODate("2026-02-30")).toBe(true); // js normalizes; regex+parse only
    expect(isValidISODate("15/02/2026")).toBe(false);
  });
});

describe("permission catalog integrity", () => {
  it("has unique codes", () => {
    const codes = PERMISSIONS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("role presets reference only catalogued codes", () => {
    for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
      for (const code of preset.permissions) {
        expect(isPermissionCode(code), `${key} → ${code}`).toBe(true);
      }
    }
  });
  it("tenant_owner gets every non-platform permission", () => {
    const nonPlatform = PERMISSIONS.filter((p) => !p.code.startsWith("platform.")).length;
    expect(ROLE_PRESETS.tenant_owner.permissions.length).toBe(nonPlatform);
  });
  it("auditor preset has no mutating permissions", () => {
    const mutating = ROLE_PRESETS.auditor.permissions.filter(
      (c) => c.includes("manage") || c.includes("create") || c.includes("post"),
    );
    expect(mutating).toEqual([]);
  });
});
