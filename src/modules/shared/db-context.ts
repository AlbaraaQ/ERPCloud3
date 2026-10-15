/**
 * Tenant-scoped transactions (D-002 layer 1+2).
 * `withTenant` opens a DB transaction, binds `app.tenant_id` (used by RLS
 * policies — layer 2, defense in depth), then runs the unit of work.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { errors } from "./result";

/** Tenant states in which the tenant may still be written to (PLATFORM_ADMIN §1.1). */
const WRITABLE_STATUSES = new Set(["trial", "active"]);

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
export async function withTenant<T>(
  tenantId: string,
  fn: (trx: Trx) => Promise<T>,
  opts: { writable?: boolean } = {},
): Promise<T> {
  // Suspension is enforced at the DATABASE level, not by asking each call site to
  // remember a guard: a non-active tenant gets a READ ONLY transaction, so *any*
  // write — from an action, a job or a script — fails with SQLSTATE 25006 while
  // every read keeps working (PLATFORM_ADMIN §1.1: suspension preserves history,
  // read-only + export, never destructive). `writable: true` is the explicit,
  // audited escape hatch for platform operations (e.g. the purge workflow).
  const status = await tenantStatus(tenantId);
  const readOnly = !opts.writable && status !== null && !WRITABLE_STATUSES.has(status);

  return db.transaction(async (trx) => {
    if (readOnly) {
      // must be the first statement of the transaction block
      await trx.execute(sql`set transaction read only`);
    }
    // transaction-local (3rd arg true): safe under connection pooling
    await trx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    if (readOnly) await trx.execute(sql`select set_config('app.read_only', 'on', true)`);
    await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
    try {
      return await fn(trx);
    } catch (e) {
      if (readOnly && (e as { code?: string }).code === "25006") {
        throw errors.validation("errors.tenantReadOnly", "write attempted on a non-active tenant");
      }
      throw e;
    }
  });
}

/** Tenant lifecycle status (platform/infrastructure read — no tenant binding). */
async function tenantStatus(tenantId: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`select status::text as status from tenants where id = ${tenantId}::uuid`,
  )) as unknown as { rows: { status: string }[] };
  return rows.rows[0]?.status ?? null;
}

/** Run without tenant binding — platform-level infrastructure only. */
export async function withSystem<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => fn(trx));
}

/** Set tenant context inside an existing transaction (composable services). */
export async function bindTenant(trx: Pick<Trx, "execute">, tenantId: string): Promise<void> {
  await trx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}
