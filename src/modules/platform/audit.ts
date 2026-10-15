/**
 * Platform audit log (PLATFORM_ADMIN §3, D-018/D-020).
 *
 * Every console action — tenant create/suspend, plan change, flag change, backup
 * operation, grant create, export, restore step — appends here through the
 * SECURITY DEFINER `write_platform_audit` function, which maintains its own
 * hash chain (separate from the per-tenant chains). Append-only: the function
 * is the only writer and UPDATE/DELETE are revoked.
 *
 * Tenant-visible events are ALSO written to the tenant chain (`audit_log`) so a
 * tenant sees platform actions affecting it in its own audit view.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { newId } from "@/modules/shared/ids";
import type { Trx } from "@/modules/shared/db-context";
import { writeAudit } from "@/modules/shared/audit";

type Executor = Pick<Trx, "execute"> | typeof db;

export interface PlatformAuditInput {
  actorPlatformUserId?: string | null;
  actorLabel: string;
  action: string; // e.g. "tenant.suspended"
  entity?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  /** When the action concerns a tenant, mirror it into that tenant's chain. */
  alsoAuditTenantId?: string | null;
}

export async function writePlatformAudit(exec: Executor, input: PlatformAuditInput): Promise<void> {
  await (exec as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
    select public.write_platform_audit(
      ${newId()}::uuid,
      ${input.actorPlatformUserId ?? null}::uuid,
      ${input.actorLabel},
      ${input.action},
      ${input.entity ?? null},
      ${input.entityId ?? null},
      ${input.before == null ? null : JSON.stringify(input.before)}::jsonb,
      ${input.after == null ? null : JSON.stringify(input.after)}::jsonb,
      ${input.ip ?? null},
      ${input.userAgent ?? null}
    )
  `);

  // The tenant must be able to see what the platform did to its account.
  if (input.alsoAuditTenantId) {
    await writeAudit(exec, {
      tenantId: input.alsoAuditTenantId,
      actorUserId: null,
      actorPlatformUserId: input.actorPlatformUserId ?? null,
      actorLabel: input.actorLabel,
      action: `platform.${input.action}`,
      entity: input.entity,
      entityId: input.entityId,
      after: input.after,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenId?: string | null;
  brokenAt?: Date | null;
  detail?: string | null;
}

/**
 * Recompute the platform audit chain from the stored rows (same expressions as
 * the writer, in the database, so jsonb/timestamp rendering can never drift).
 * A broken link is reported with the offending row — never silently ignored.
 */
export async function verifyAuditChain(limit = 1000): Promise<ChainVerification> {
  const res = (await db.execute(
    sql`select ok, checked, broken_id, broken_at, detail from public.verify_platform_audit_chain(${limit})`,
  )) as unknown as {
    rows: { ok: boolean; checked: number; broken_id: string | null; broken_at: Date | null; detail: string | null }[];
  };
  const row = res.rows[0];
  if (!row) return { ok: false, checked: 0, detail: "chain verification returned no row" };
  return {
    ok: Boolean(row.ok),
    checked: Number(row.checked),
    brokenId: row.broken_id,
    brokenAt: row.broken_at,
    detail: row.detail,
  };
}
