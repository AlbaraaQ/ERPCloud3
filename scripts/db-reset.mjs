/**
 * Sandbox DB reset: drop → drizzle push → RLS → seed.
 * Intended for the embedded Postgres of `scripts/dev-postgres.mjs` (destructive!).
 * NEVER point this at a database that holds real data.
 *
 * Usage: node scripts/db-reset.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import "dotenv/config";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const { Client } = pg;
const client = new Client({ connectionString: url });
await client.connect();

console.log("[db-reset] dropping schema public");
await client.query("drop schema public cascade");
await client.query("create schema public");
await client.end();

console.log("[db-reset] drizzle-kit push");
execFileSync("npx", ["drizzle-kit", "push", "--force"], { stdio: "inherit" });

console.log("[db-reset] applying src/db/rls.sql");
const c2 = new Client({ connectionString: url });
await c2.connect();
await c2.query(readFileSync("src/db/rls.sql", "utf8"));
await c2.end();

console.log("[db-reset] seeding");
execFileSync("npx", ["tsx", "scripts/seed.ts"], { stdio: "inherit" });

console.log("[db-reset] done");
