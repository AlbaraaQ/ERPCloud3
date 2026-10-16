/**
 * The documented setup workflow, executed for real: `env:setup` → `env:check`.
 *
 * A guard test on text can only prove that a file mentions a command. These tests *run* the
 * commands in a throwaway directory and assert the resulting environment is actually usable —
 * which is the difference between "the guide looks right" and "a new operator can start".
 *
 * The regression they lock down is concrete: the seeded demo password contains `#`, dotenv ends
 * a bare value at `#`, so `SEED_DEMO_PASSWORD=Hisab#2026` silently became `Hisab` — the seed
 * hashed `Hisab`, the login screen compared against `Hisab#2026`, and every demo sign-in failed
 * without a clear error. `env:setup` therefore writes the value **quoted**, and `env:check`
 * refuses to let that shape through unnoticed.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseDotenv } from "dotenv";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SETUP = path.join(ROOT, "scripts/env-setup.mts");
const CHECK = path.join(ROOT, "scripts/env-check.mts");

function sandbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hisab-env-"));
  copyFileSync(path.join(ROOT, ".env.example"), path.join(dir, ".env.example"));
  return dir;
}

/** Run a script with `cwd` inside the sandbox; returns stdout/stderr and exit code. */
function run(script: string, cwd: string, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", script, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" },
    });
    return { code: 0, out };
  } catch (e) {
    const error = e as { status?: number; stdout?: string; stderr?: string };
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

describe("npm run env:setup", () => {
  it("produces a .env whose values survive the dotenv parser intact", () => {
    const dir = sandbox();
    try {
      const result = run(SETUP, dir);
      expect(result.code, result.out).toBe(0);

      const envPath = path.join(dir, ".env");
      const env = parseDotenv(readFileSync(envPath, "utf8"));

      // the key must be a real 32-byte value, not a placeholder
      const key = env.HISAB_ENCRYPTION_KEY ?? "";
      expect(key.length).toBeGreaterThan(40);
      expect(Buffer.from(key, "base64").length).toBe(32);

      // the exact defect: '#" must not truncate the password
      expect(env.SEED_DEMO_PASSWORD).toBe("Hisab#2026");
      expect(env.SEED_BOOTSTRAP_PASSWORD).toBe("Hisab#2026");
      expect(env.DATABASE_URL).toMatch(/^postgresql:\/\//);

      // a secret file is owner-only
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an existing .env alone (and says so) instead of rotating the key", () => {
    const dir = sandbox();
    try {
      expect(run(SETUP, dir).code).toBe(0);
      const first = parseDotenv(readFileSync(path.join(dir, ".env"), "utf8"));

      const second = run(SETUP, dir);
      expect(second.code, second.out).toBe(0);
      expect(second.out).toContain("left untouched");
      const after = parseDotenv(readFileSync(path.join(dir, ".env"), "utf8"));
      expect(after.HISAB_ENCRYPTION_KEY).toBe(first.HISAB_ENCRYPTION_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("npm run env:check", () => {
  it("accepts the environment env:setup just produced", () => {
    const dir = sandbox();
    try {
      expect(run(SETUP, dir).code).toBe(0);
      const check = run(CHECK, dir);
      expect(check.code, check.out).toBe(0);
      expect(check.out).toContain("سليم");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a truncated secret and an empty encryption key, with a readable reason", () => {
    const dir = sandbox();
    try {
      const envPath = path.join(dir, ".env");
      writeFileSync(
        envPath,
        [
          "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db",
          "HISAB_ENCRYPTION_KEY=",
          "SEED_DEMO_PASSWORD=Hisab#2026",
          "",
        ].join("\n"),
      );
      const check = run(CHECK, dir);
      expect(check.code).toBe(1);
      expect(check.out).toContain("HISAB_ENCRYPTION_KEY");
      expect(check.out).toContain("SEED_DEMO_PASSWORD");
      expect(check.out).toContain("تسجيل الدخول"); // the Arabic explanation, not just English
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a key that is not 32 bytes", () => {
    const dir = sandbox();
    try {
      writeFileSync(
        path.join(dir, ".env"),
        "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db\nHISAB_ENCRYPTION_KEY=c2hvcnQ=\n",
      );
      const check = run(CHECK, dir);
      expect(check.code).toBe(1);
      expect(check.out).toContain("32");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
