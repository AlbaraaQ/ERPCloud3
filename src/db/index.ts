import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "./schema";
import { logger } from "@/modules/shared/logger";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __hisabPgPool?: Pool;
};

export const pool =
  globalForDb.__hisabPgPool ??
  new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

/**
 * node-postgres emits `error` on the pool when a *background* client fails. With
 * no listener Node turns that into an uncaught exception and the process dies —
 * so one dead connection (network blip, server restart, engine quirk) would take
 * the whole app with it. We log and let the pool discard the client; the next
 * query gets a fresh one.
 */
pool.on("error", (err) => {
  logger.error({ err }, "pg pool client error — client discarded");
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.__hisabPgPool = pool;
}

export const db = drizzle(pool, { schema });
