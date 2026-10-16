/**
 * Phase 10 — "every screen is behind a server-side guard", locked as a test.
 *
 * The AI-assistant session added a rule worth keeping: *navigation visibility is a
 * convenience, the guard is the control.* These assertions are structural, not
 * behavioural — they read the source tree — and they exist because the cheapest way
 * for a guard to disappear is a refactor that moves a page, renames a layout, or
 * copies a permission code with a typo. Behavioural coverage of the same rules lives
 * in the integration suites (authZ matrix, tenant/platform isolation, platform ops);
 * this file makes the *shape* of the app fail loudly when it changes.
 *
 * No database, no HTTP: pure text inspection of `src/`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/modules/shared/permissions";
import { PLATFORM_PERMISSIONS, platformPermissionsFor } from "@/modules/platform/permissions";

const ROOT = path.resolve(import.meta.dirname, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const ALL_FILES = walk(ROOT);
const rel = (file: string) => path.relative(path.resolve(import.meta.dirname, "../.."), file);
const read = (file: string) => readFileSync(file, "utf8");

/** Any of these in a page or one of its layouts means a server-side guard runs. */
const GUARD_MARKERS =
  /getSessionContext|getPlatformContext|requirePlatformPermission|requirePlatformOwner|requirePlatform\(|requirePermission\(|requireTenant\(|requireOperableTenant\(/;

/** Screens that exist to *get* a session: guarding them would guard the login form. */
const PRE_AUTH = [
  "(auth)/login",
  "platform/login",
];

const pages = ALL_FILES.filter((f) => f.endsWith(`page.tsx`));

function layoutChain(page: string): string[] {
  const chain: string[] = [];
  let dir = path.dirname(page);
  while (dir.startsWith(ROOT)) {
    const layout = path.join(dir, "layout.tsx");
    if (ALL_FILES.includes(layout)) chain.push(layout);
    if (dir === ROOT) break;
    dir = path.dirname(dir);
  }
  return chain;
}

/** Guard call sites with a literal code argument (the codes that must exist). */
function codesAtCallSites(fn: string): { file: string; code: string }[] {
  const found: { file: string; code: string }[] = [];
  const pattern = new RegExp(`${fn}\\([^)]*?"([^"]+)"`, "g");
  for (const file of ALL_FILES) {
    const text = read(file);
    for (const match of text.matchAll(pattern)) found.push({ file: rel(file), code: match[1]! });
  }
  return found;
}

describe("server-side guards", () => {
  it("covers every page, directly or through its layouts", () => {
    const unguarded = pages
      .filter((page) => !PRE_AUTH.some((prefix) => rel(page).includes(prefix)))
      .filter((page) => {
        const text = [read(page), ...layoutChain(page).map(read)].join("\n");
        return !GUARD_MARKERS.test(text);
      })
      .map(rel);

    expect(unguarded, "a page renders without any session/platform guard above it").toEqual([]);
  });

  it("gives every platform console page the console identity (no tenant-session access)", () => {
    const missing = pages
      .filter((page) => rel(page).startsWith("src/app/platform/"))
      .filter((page) => !rel(page).includes("platform/login"))
      .filter((page) => !read(page).includes("getPlatformContext"))
      .map(rel);

    expect(missing, "a console page does not resolve a platform context").toEqual([]);
  });

  it("is the only door into the console tree", () => {
    // The console layout is the single place the platform session is turned into a
    // rendered shell; an extra entry point would be a second door to protect.
    const layouts = ALL_FILES.filter((f) => f.endsWith("layout.tsx")).map(rel);
    expect(layouts.filter((f) => f.startsWith("src/app/platform/"))).toEqual([
      "src/app/platform/(console)/layout.tsx",
    ]);
  });
});

describe("permission codes", () => {
  const platformCodes = new Set<string>(PLATFORM_PERMISSIONS);
  const tenantCodes = new Set<string>(PERMISSIONS.map((p) => p.code));

  it("exist in the platform catalogue wherever the console asks for one", () => {
    const offenders = [
      ...codesAtCallSites("requirePlatformPermission"),
      ...codesAtCallSites("hasPlatformPermission"),
    ].filter(({ code }) => !platformCodes.has(code));

    expect(offenders, "a console guard names a permission that does not exist").toEqual([]);
  });

  it("exist in the tenant catalogue wherever tenant code asks for one", () => {
    // Only the *tenancy* guards are inspected; service-level checks use the same
    // helper with dynamic codes and are covered by the integration suites.
    const offenders = ALL_FILES.filter((f) => rel(f).startsWith("src/app/"))
      .flatMap((file) => {
        const found: { file: string; code: string }[] = [];
        for (const match of read(file).matchAll(/requirePermission\([^)]*?"([^"]+)"/g)) {
          found.push({ file: rel(file), code: match[1]! });
        }
        return found;
      })
      .filter(({ code }) => !tenantCodes.has(code));

    expect(offenders, "a page names a tenant permission that does not exist").toEqual([]);
  });

  it("are the ones the navigation actually uses", () => {
    const shell = read(path.join(ROOT, "components/shell/app-shell.tsx"));
    const navCodes = [...shell.matchAll(/perm: "([^"]+)"/g)].map((m) => m[1]!);
    expect(navCodes.length).toBeGreaterThan(8);
    expect(navCodes.filter((code) => !tenantCodes.has(code))).toEqual([]);
    // A platform code in tenant navigation would be a design break, not a typo:
    // tenant roles cannot hold platform permissions at all.
    expect(navCodes.filter((code) => code.startsWith("platform."))).toEqual([]);
  });
});

describe("role boundaries", () => {
  it("keeps destruction away from the ops role", () => {
    const ops = platformPermissionsFor("ops");
    const destructive = [
      "platform.backup.restore",
      "platform.data.delete",
      "platform.grants.approve",
      "platform.plans.manage",
      "platform.flags.manage",
      "platform.settings.manage",
    ];
    expect([...ops].filter((code) => destructive.includes(code))).toEqual([]);
  });

  it("gives both console roles every read they need to do their job", () => {
    const views = PLATFORM_PERMISSIONS.filter((code) => code.endsWith(".view"));
    for (const role of ["owner", "ops"]) {
      const granted = platformPermissionsFor(role);
      expect([...views].filter((code) => !granted.has(code)), `${role} cannot read a screen`).toEqual([]);
    }
  });

  it("keeps unknown roles empty rather than generous", () => {
    expect([...platformPermissionsFor("intern")]).toEqual([]);
    expect([...platformPermissionsFor("")]).toEqual([]);
  });
});

describe("namespace separation", () => {
  /**
   * Tenant code paths that may import `@/modules/platform/*`. Anything else means a
   * tenant screen reached platform services — the exact coupling PLATFORM_ADMIN §1
   * forbids. Adding a file here is a decision, not a fix: the worker and the two
   * platform-facing API routes run *outside* a tenant request.
   */
  const ALLOWED_PLATFORM_IMPORTERS = new Set([
    "src/app/api/health/route.ts",
    "src/app/api/platform/export/[id]/route.ts",
    "src/modules/ai/intents.ts",
    "src/modules/jobs/worker.ts",
  ]);

  it("lets only the listed non-platform files import platform modules", () => {
    const importers = ALL_FILES.filter((file) => read(file).includes("@/modules/platform"))
      .map(rel)
      .filter((file) => !file.startsWith("src/modules/platform/") && !file.startsWith("src/app/platform/"))
      .filter((file) => !ALLOWED_PLATFORM_IMPORTERS.has(file))
      .sort();

    expect(importers, "tenant code imports platform services").toEqual([]);
  });

  it("keeps tenant screens and components out of the console tree", () => {
    const tenantTrees = ["src/app/(app)", "src/app/(rep)", "src/components"];
    const offenders = ALL_FILES.map(rel)
      .filter((file) => tenantTrees.some((tree) => file.startsWith(tree)))
      .filter((file) => file.includes("@/modules/platform") || file.includes("app/platform/"))
      .sort();
    expect(offenders).toEqual([]);
  });
});
