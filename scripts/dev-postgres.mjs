/**
 * Sandbox-only embedded PostgreSQL (PGlite + wire-protocol socket).
 *
 * WHY: some sandboxes (including this project's dev sandbox) have no Postgres
 * server and no package-manager access to install one. PGlite is the real
 * PostgreSQL engine compiled to WASM, and `@electric-sql/pglite-socket` speaks
 * the PostgreSQL wire protocol, so the application keeps using its normal
 * `pg` / drizzle / node-postgres path with `DATABASE_URL` unchanged.
 *
 * SCOPE / LIMITS (documented, not hidden):
 *   - single-connection semantics (queries are serialized by PGlite);
 *   - LISTEN/NOTIFY and pg-boss schedulers are not available → run with
 *     ENABLE_WORKER=false and trigger jobs directly (`npm run zatca:run`);
 *   - never a production database: ephemeral data directory by default.
 *
 * Usage:  node scripts/dev-postgres.mjs [--port 5432] [--dir .pglite]
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const port = Number(getArg("port", process.env.PGLITE_PORT ?? 5432));
const host = getArg("host", "127.0.0.1");
const dataDir = getArg("dir", ".pglite");
const bootstrapSql = getArg("bootstrap", "");

const db = await PGlite.create({
  dataDir,
  extensions: { pgcrypto },
  // PGlite's WASM runtime is single-threaded; relaxed durability keeps dev fast
  relaxedDurability: true,
});

async function applySqlFile(path) {
  if (!existsSync(path)) return;
  const sql = readFileSync(path, "utf8");
  await db.exec(sql);
  console.log(`[dev-postgres] applied ${path}`);
}

// maxConnections: the wire server defaults to 1 concurrent client, which kills
// pooled clients (node-postgres opens one socket per pool slot) — raise it.
const server = new PGLiteSocketServer({
  db,
  port,
  host,
  maxConnections: Number(getArg("max-connections", process.env.PGLITE_MAX_CONNECTIONS ?? 60)),
  idleTimeout: 0,
});
server.addEventListener("error", (e) => console.error("[dev-postgres] socket error:", e?.message ?? e));
server.addEventListener("close", () => console.error("[dev-postgres] socket server closed"));
await server.start();
const [{ version } = { version: "unknown" }] = (
  await db.query("select version() as version")
).rows;
console.log(`[dev-postgres] ${version}`);
console.log(`[dev-postgres] serving postgres wire protocol on ${host}:${port} (dataDir=${dataDir})`);

process.on("uncaughtException", (e) => console.error("[dev-postgres] uncaught:", e));
process.on("unhandledRejection", (e) => console.error("[dev-postgres] unhandled rejection:", e));

if (bootstrapSql) {
  for (const f of bootstrapSql.split(",")) await applySqlFile(f.trim());
}

// Health probe (independent of the wire protocol) so supervisors can check liveness.
createServer((req, res) => {
  if (req.url === "/health") {
    db.query("select 1")
      .then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, engine: "pglite", port }));
      })
      .catch((e) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      });
    return;
  }
  res.writeHead(404).end();
}).listen(port + 1, "0.0.0.0", () => {
  console.log(`[dev-postgres] plain-HTTP health on 0.0.0.0:${port + 1}/health`);
});

const shutdown = async () => {
  console.log("[dev-postgres] stopping…");
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
