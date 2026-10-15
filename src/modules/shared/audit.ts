/**
 * Audit log (D-018). Writes go through the SECURITY DEFINER `write_audit`
 * function (see src/db/rls.sql) which maintains the per-tenant hash chain
 * (tamper evidence) and works regardless of RLS read policies.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Trx } from "./db-context";
import { newId } from "./ids";

export interface AuditInput {
  tenantId: string | null;
  actorUserId?: string | null;
  actorPlatformUserId?: string | null;
  actorLabel: string;
  action: string; // e.g. "auth.login.success"
  entity?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

type Executor = Pick<Trx, "execute"> | typeof db;

/**
 * Append an audit row. Call inside the same transaction as the change
 * whenever one exists (pass the trx) so audit and change commit atomically.
 */
export async function writeAudit(exec: Executor, input: AuditInput): Promise<void> {
  await (exec as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
    select public.write_audit(
      ${newId()}::uuid,
      ${input.tenantId}::uuid,
      ${input.actorUserId ?? null}::uuid,
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
}
