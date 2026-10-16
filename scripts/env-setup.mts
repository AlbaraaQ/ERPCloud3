/**
 * `npm run env:setup` — create `.env` from the tracked template, safely and without guessing.
 *
 * What it does:
 *   1. if `.env` already exists it is left alone (only a summary is printed) — an operator
 *      must never lose a working configuration to a convenience command;
 *   2. otherwise `.env` is copied from `.env.example` and the two values that cannot be
 *      defaulted are filled in:
 *        - `HISAB_ENCRYPTION_KEY`: a real 32-byte key (base64) generated here. Without it the
 *          app cannot decrypt ZATCA private keys nor write an encrypted backup, so a template
 *          that leaves it empty hands the operator a broken system;
 *        - the seeded passwords, **quoted**, because dotenv treats a bare `#` as a comment
 *          start (`Hisab#2026` silently became `Hisab`, which broke every demo login).
 *   3. prints what remains manual (the database URL if it is not the dev default).
 *
 * Flags: `--force` overwrites an existing `.env` (asks nothing, so it is explicit),
 *        `--password=<value>` chooses the seeded password (default keeps the documented one).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import "dotenv/config";

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");
const TEMPLATE_PATH = path.join(ROOT, ".env.example");

const force = process.argv.includes("--force");
const passwordArg = process.argv.find((a) => a.startsWith("--password="))?.split("=")[1];
const DEFAULT_PASSWORD = "Hisab#2026";

if (!existsSync(TEMPLATE_PATH)) {
  console.error("✗ .env.example is missing — it is tracked in git, restore it first");
  process.exit(1);
}

/** dotenv-compatible quoting: a value with `#` or spaces must be quoted. */
function quote(value: string): string {
  return /[#\s"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function fill(text: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (!pattern.test(text)) {
    console.warn(`  ! ${key} is not declared in .env.example — skipped`);
    return text;
  }
  return text.replace(pattern, `${key}=${quote(value)}`);
}

const template = readFileSync(TEMPLATE_PATH, "utf8");
const password = passwordArg ?? process.env.SEED_DEMO_PASSWORD ?? DEFAULT_PASSWORD;

if (existsSync(ENV_PATH) && !force) {
  const current = readFileSync(ENV_PATH, "utf8");
  const active = current
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=.+/.test(line))
    .map((line) => line.split("=")[0]!);
  console.log("✓ .env already exists — left untouched");
  console.log(`  active variables: ${active.join(", ") || "(none)"}`);
  if (!/^HISAB_ENCRYPTION_KEY=.+/m.test(current)) {
    console.log("  ! HISAB_ENCRYPTION_KEY is empty: backups and stored ZATCA keys cannot be read");
  }
  if (/^SEED_DEMO_PASSWORD=[^"'#]*#/.test(current)) {
    console.log('  ! SEED_DEMO_PASSWORD looks unquoted and contains "#": dotenv will truncate it');
  }
  console.log("  re-run with --force to regenerate from the template (this rotates the key)");
  process.exit(0);
}

const key = randomBytes(32).toString("base64");
let out = template;
out = fill(out, "HISAB_ENCRYPTION_KEY", key);
out = fill(out, "SEED_BOOTSTRAP_PASSWORD", password);
out = fill(out, "SEED_DEMO_PASSWORD", password);
writeFileSync(ENV_PATH, out, { mode: 0o600 });

console.log(`✓ wrote .env from .env.example${force ? " (forced overwrite)" : ""}`);
console.log(`  HISAB_ENCRYPTION_KEY: generated now (${key.length} chars, base64)`);
console.log(`  seeded passwords: set and quoted (${password.length} chars)`);
console.log("  next:");
console.log("    npm run db:migrate     # schema + row-level-security policies");
console.log("    npm run db:seed        # permission catalog, platform owner, demo tenants");
console.log("  check:");
console.log("    npm run env:check      # fails early with a clear reason if something is missing");
