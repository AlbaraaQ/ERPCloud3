/**
 * Tenant-scoped transactions (D-002 layer 1+2).
 * `withTenant` opens a DB transaction, binds `app.tenant_id` (used by RLS
 * policies — layer 2, defense in depth), then runs the unit of work.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";

/** Transaction handle as inferred from our Drizzle client (node-postgres). */
export type Trx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside a transaction with tenant RLS context bound.
 * Every tenant-scoped service write/read goes through this (or binds the
 * same config inside an outer transaction via `bindTenant`).
 *
 * LOCK ORDER (Phase-3 deadlock fix, uniform rule): the per-tenant advisory
 * lock is acquired FIRST — before any row lock — so concurrent tenant writes
 * serialize cleanly instead of cycling (advisory ↔ row-lock inversion).
 * Trade-off (documented): intra-tenant writes serialize per transaction;
 * acceptable at SME scale since posting transactions are short. A finer
 * per-entity ordered-lock design can replace the gate if contention shows.
 * It also matches the key write_audit takes for its hash chain (re-entrant).
 */
export async function withTenant<T>(tenantId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    // transaction-local (3rd arg true): safe under connection pooling
    await trx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
    return fn(trx);
  });
}

/** Run without tenant binding — platform-level infrastructure only. */
export async function withSystem<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => fn(trx));
}

/** Set tenant context inside an existing transaction (composable services). */
export async function bindTenant(trx: Pick<Trx, "execute">, tenantId: string): Promise<void> {
  await trx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}
