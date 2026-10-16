/**
 * `npm run db:migrate` — bring the database schema and its security policies up to date.
 *
 * This project does not ship versioned migration files (recorded as a release blocker in
 * docs/RELEASE_READINESS.md §5). Until that changes, the authoritative schema is
 * `src/db/schema.ts` and it is applied with `drizzle-kit push`, followed by `src/db/rls.sql`
 * — the row-level-security policies. **The policies are not optional**: they are the second
 * isolation layer, so a "migrate" that forgot them would leave a tenant-boundary bug that no
 * application test can see.
 *
 * Non-destructive: it never drops the schema. `npm run db:reset` does that (dev only).
 *
 * Flags: `--yes` skip the confirmation prompt (used by scripts),
 *        `--no-rls` skip the policy application (escape hatch, prints a warning).
 */

import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import "dotenv/config";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL is required — run `npm run env:setup` first");
  process.exit(1);
}
const yes = process.argv.includes("--yes");
const withRls = !process.argv.includes("--no-rls");

const safeUrl = url.replace(/\/\/[^@]*@/, "//***@");
console.log(`[db:migrate] target  ${safeUrl}`);
console.log("[db:migrate] schema   src/db/schema.ts via drizzle-kit push (non-destructive)");

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Apply the current schema to this database? [y/N] ");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("[db:migrate] cancelled");
    process.exit(0);
  }
}

// An empty database is a normal case (drizzle-kit handles it); an unreachable one is not.
try {
  const probe = new pg.Client({ connectionString: url });
  await probe.connect();
  const { rows } = await probe.query(
    "select (select count(*) from information_schema.tables where table_schema = 'public')::int as tables",
  );
  await probe.end();
  console.log(`[db:migrate] reachable — ${rows[0].tables} table(s) currently in schema public`);
} catch (e) {
  console.error(`✗ cannot reach the database: ${e instanceof Error ? e.message : String(e)}`);
  console.error("  start the dev engine with: node scripts/dev-postgres.mjs --dir .pglite");
  process.exit(1);
}

console.log("[db:migrate] drizzle-kit push");
execFileSync("npx", ["drizzle-kit", "push", "--force"], { stdio: "inherit" });

if (!withRls) {
  console.warn("! [db:migrate] --no-rls: row-level-security policies were NOT applied");
} else {
  console.log("[db:migrate] applying src/db/rls.sql (tenant isolation policies)");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(readFileSync("src/db/rls.sql", "utf8"));
    const { rows } = await client.query(
      "select count(*)::int as policies from pg_policies where schemaname = 'public'",
    );
    console.log(`[db:migrate] ✓ schema current — ${rows[0].policies} policies active`);
  } finally {
    await client.end();
  }
}

console.log("[db:migrate] next: npm run db:seed   (permission catalog, platform owner, demo tenants)");
