/**
 * `.env.example` must be real, complete and secret-free.
 *
 * This suite exists because the operations guide told a new operator to run
 * `cp .env.example .env` while **no such file existed**: the documentation described an
 * onboarding step the repository could not perform. Documentation that names a file is a
 * promise; these assertions keep the promise, and they fail in the cheap direction —
 * a missing variable in the template, never a leaked secret in it.
 *
 * Three rules, in the order the template's own header states them:
 *   1. every environment variable read by `src/` or `scripts/` appears in the template;
 *   2. every variable documented in the guide's environment table appears in the template;
 *   3. no secret is *filled in* — secret keys must be present but empty.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEMPLATE = readFileSync(path.join(ROOT, ".env.example"), "utf8");
const GUIDE = readFileSync(path.join(ROOT, "docs/OPERATIONS_GUIDE.md"), "utf8");
const GITIGNORE = readFileSync(path.join(ROOT, ".gitignore"), "utf8");

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const full = path.join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) walk(path.join(dir, entry), out);
    else out.push(path.join(dir, entry));
  }
  return out;
};

/** Variables the framework or the shell provides — the app must not template them. */
const FRAMEWORK_VARS = new Set(["NODE_ENV", "NEXT_RUNTIME", "USER"]);

/** Keys the template *declares* (active or commented out): `KEY=` / `# KEY=`. */
function declaredKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

/** Keys assigned a **non-empty** value (i.e. what the template would really export). */
function assignedValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  return values;
}

const DECLARED = declaredKeys(TEMPLATE);
const ASSIGNED = assignedValues(TEMPLATE);

/** Variables actually read by the application and its operational scripts. */
const REFERENCED = (() => {
  const found = new Set<string>();
  for (const file of [...walk("src"), ...walk("scripts")]) {
    if (!/\.(ts|tsx|mts|mjs)$/.test(file)) continue;
    const text = read(file);
    for (const match of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\])/g)) {
      found.add(match[1] ?? match[2]!);
    }
  }
  return found;
})();

const SECRET_KEYS = [
  "HISAB_ENCRYPTION_KEY",
  "SEED_BOOTSTRAP_PASSWORD",
  "SEED_DEMO_PASSWORD",
  "ASSISTANT_API_KEY",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
];

describe("the environment template exists and is usable", () => {
  it("is committed, not ignored, and non-trivial", () => {
    expect(TEMPLATE.length).toBeGreaterThan(500);
    // `.env` is ignored; the template must survive that rule (an explicit negation documents
    // the intent and protects the file if the ignore pattern is ever broadened to `.env*`).
    expect(GITIGNORE).toContain("!.env.example");
  });

  it("carries the required variables the app refuses to start without", () => {
    for (const key of ["DATABASE_URL", "HISAB_ENCRYPTION_KEY"]) {
      expect(ASSIGNED.get(key) !== undefined, `${key} must exist as an assignment`).toBe(true);
    }
    // DATABASE_URL is a documented example connection, not a secret.
    expect(ASSIGNED.get("DATABASE_URL")).toMatch(/^postgres(ql)?:\/\//);
  });
});

describe("template completeness", () => {
  it("declares every environment variable the code reads", () => {
    const missing = [...REFERENCED]
      .filter((key) => !FRAMEWORK_VARS.has(key))
      .filter((key) => !DECLARED.has(key))
      .sort();
    expect(missing, "variables read by src/ or scripts/ but absent from .env.example").toEqual([]);
  });

  it("declares every variable the operations guide documents", () => {
    // The guide's environment table is the second contract: a table row promises the
    // operator that the variable is settable, so it must be settable. Only that table is
    // parsed — the rest of the guide is prose and mentions tokens like LISTEN/NOTIFY.
    const table = GUIDE.split("### 1.5")[1]?.split("### 1.6")[0] ?? "";
    expect(table, "the environment table moved; update this assertion").not.toBe("");
    const guideKeys = [...table.matchAll(/^\|\s*`([^`]+)`/gm)]
      .flatMap((row) => row[1]!.split("/"))
      .map((key) => key.trim())
      .filter((key) => /^[A-Z][A-Z0-9_]{3,}$/.test(key));
    expect(guideKeys.length, "the environment table seems empty").toBeGreaterThan(8);
    const missing = [...new Set(guideKeys)].filter((key) => !DECLARED.has(key)).sort();
    expect(missing, "variables documented in OPERATIONS_GUIDE.md but absent from .env.example").toEqual([]);
  });

  it("keeps the guide pointing at a file that exists", () => {
    if (/cp \.env\.example \.env/.test(GUIDE)) {
      expect(read(".env.example").length).toBeGreaterThan(0);
    }
  });
});

describe("template safety", () => {
  it("never fills in a secret", () => {
    for (const key of SECRET_KEYS) {
      if (!DECLARED.has(key)) continue;
      const value = ASSIGNED.get(key) ?? "";
      expect(value, `${key} must be present but empty in the template`).toBe("");
    }
  });

  it("does not hand out a working encryption key or password by default", () => {
    const suspicious = [...ASSIGNED.entries()].filter(
      ([key, value]) =>
        value !== "" &&
        /KEY|PASSWORD|SECRET|TOKEN|CLIENT_ID/i.test(key) &&
        !/^(DATABASE_URL|SEED_PLATFORM_EMAIL)$/.test(key),
    );
    expect(suspicious.map(([k]) => k), "a secret-looking variable has a default value").toEqual([]);
  });

  it("keeps live restore off by default", () => {
    expect(ASSIGNED.get("HISAB_ALLOW_LIVE_RESTORE")).toBeUndefined();
  });
});
