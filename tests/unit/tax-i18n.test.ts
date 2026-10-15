/**
 * i18n coverage guard: every message key the tax module can surface must exist in
 * BOTH dictionaries (ar + en). A missing key reaches the user as a raw identifier,
 * which breaks the "actionable Arabic message" acceptance criterion.
 *
 * The keys are collected from the source instead of a hand-kept list, so a new
 * validator rule cannot ship without its message.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ar } from "@/i18n/ar";
import { en } from "@/i18n/en";

const ROOTS = ["src/modules/tax", "src/app/(app)/tax", "src/modules/shared"];
/** quoted string literals only — bare member access (`errors.validation(...)`) is not a message key */
const KEY_RE = /"(errors|taxPg|tax\.validation)\.[a-zA-Z0-9]+"/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function lookup(dict: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined),
      dict,
    );
}

describe("tax module i18n coverage", () => {
  const keys = new Set<string>();
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      for (const m of readFileSync(file, "utf8").matchAll(KEY_RE)) keys.add(m[0].slice(1, -1));
    }
  }

  it("collects the keys emitted by the tax module", () => {
    expect(keys.size).toBeGreaterThan(30);
    expect([...keys].some((k) => k.startsWith("tax.validation."))).toBe(true);
  });

  it("resolves every key in Arabic and English", () => {
    const missing: string[] = [];
    for (const key of keys) {
      if (typeof lookup(ar, key) !== "string") missing.push(`ar:${key}`);
      if (typeof lookup(en, key) !== "string") missing.push(`en:${key}`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps both dictionaries in step for the sections the module uses", () => {
    const sectionOf = (key: string) => key.split(".").slice(0, 2).join(".");
    const arKeys = new Set([...keys].filter((k) => typeof lookup(ar, k) === "string").map(sectionOf));
    const enKeys = new Set([...keys].filter((k) => typeof lookup(en, k) === "string").map(sectionOf));
    expect([...arKeys].sort()).toEqual([...enKeys].sort());
  });
});
