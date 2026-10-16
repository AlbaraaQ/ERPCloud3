/**
 * Conversation retention (AI_ASSISTANT §5, §7).
 *
 * The tenant's `retentionDays` says how long a *conversation* is kept. When it
 * expires, the thread and its messages go — and nothing else does:
 *
 *   - `ai_tool_calls` and `ai_injection_flags` **survive** (their conversation
 *     reference is set to NULL), because the audit trail is required to outlive the
 *     transcript it describes;
 *   - `ai_approval_tickets` **survive** in full: a ticket is the record of a human
 *     decision that may have produced an accounting document, and retention of chat
 *     text is not a licence to forget that;
 *   - the purge is audited in the tenant's own chain, with the counts, the cutoff and
 *     the retention window, so a tenant can see *what* was removed and *when*;
 *   - a read-only (suspended/deactivated) tenant is skipped: suspension preserves
 *     history, so a retention sweep must not run there.
 */

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiApprovalTickets, aiConversations, aiMessages } from "@/db/schema";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { writeAudit } from "@/modules/shared/audit";
import { logger } from "@/modules/shared/logger";
import { getAiConfig } from "./config";

export interface AiRetentionResult {
  tenantId: string;
  retentionDays: number;
  /** ISO instant: everything last used before this moment was removed */
  cutoff: string;
  conversations: number;
  messages: number;
  /** tickets that lost their conversation link but kept every field that matters */
  ticketsDetached: number;
  /** set when the tenant could not be swept (read-only, missing, …) */
  skippedReason?: string;
}

/** Tenant states whose data may be written to (mirrors `withTenant`'s gate). */
const WRITABLE_STATUSES = new Set(["trial", "active"]);

/** Why a tenant cannot be swept right now, or null when it can. */
async function sweepBlockedBy(tenantId: string): Promise<string | null> {
  const res = (await db.execute(
    sql`select status::text as status from tenants where id = ${tenantId}::uuid`,
  )) as unknown as { rows: { status: string }[] };
  const status = res.rows[0]?.status;
  if (!status) return "errors.notFound";
  return WRITABLE_STATUSES.has(status) ? null : "errors.tenantReadOnly";
}

/** Cutoff for a retention window. Exported so the boundary is testable on its own. */
export function retentionCutoff(days: number, now: number = Date.now()): Date {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  return new Date(now - safeDays * 86_400_000);
}

/**
 * Purge one tenant's expired conversations.
 *
 * Returns counts, never throws for "nothing to do". A read-only tenant is returned
 * as `skippedReason: "errors.tenantReadOnly"` — the caller (worker/script) reports
 * it, and no admin action is needed for a state the product chose on purpose.
 */
export async function purgeAiConversations(
  tenantId: string,
  opts: { now?: number } = {},
): Promise<AiRetentionResult> {
  const config = await getAiConfig(tenantId);
  const days = config.retentionDays;
  const cutoff = retentionCutoff(days, opts.now);
  const base: AiRetentionResult = {
    tenantId,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    conversations: 0,
    messages: 0,
    ticketsDetached: 0,
  };

  // Checked *before* the sweep, not discovered as a failed write: a suspended tenant
  // must be reported as skipped, never as "0 conversations expired" — a purge that
  // did not run and a purge that found nothing are different facts.
  const blocked = await sweepBlockedBy(tenantId);
  if (blocked) return { ...base, skippedReason: blocked };

  try {
    return await withTenant(tenantId, async (trx: Trx) => {
      const doomed = await trx
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(
          and(
            eq(aiConversations.tenantId, tenantId),
            // "last activity", not "created": a thread still in use is not expired
            sql`coalesce(${aiConversations.lastMessageAt}, ${aiConversations.createdAt}) < ${cutoff}`,
          ),
        );
      if (doomed.length === 0) return base;

      const ids = doomed.map((row) => row.id);
      const [messages] = await trx
        .select({ n: count() })
        .from(aiMessages)
        .where(and(eq(aiMessages.tenantId, tenantId), inArray(aiMessages.conversationId, ids)));
      const [tickets] = await trx
        .select({ n: count() })
        .from(aiApprovalTickets)
        .where(and(eq(aiApprovalTickets.tenantId, tenantId), inArray(aiApprovalTickets.conversationId, ids)));

      // messages cascade with their thread; tool calls / flags / tickets keep their
      // rows and lose only the reference (on delete set null)
      await trx.delete(aiConversations).where(and(eq(aiConversations.tenantId, tenantId), inArray(aiConversations.id, ids)));

      const result: AiRetentionResult = {
        ...base,
        conversations: ids.length,
        messages: Number(messages?.n ?? 0),
        ticketsDetached: Number(tickets?.n ?? 0),
      };
      await writeAudit(trx, {
        tenantId,
        actorLabel: "system:ai-retention",
        action: "ai.retention.purged",
        entity: "ai_conversation",
        entityId: null,
        after: {
          conversations: result.conversations,
          messages: result.messages,
          ticketsDetached: result.ticketsDetached,
          retentionDays: days,
          cutoff: result.cutoff,
        },
      });
      return result;
    });
  } catch (e) {
    const reason = (e as { messageKey?: string }).messageKey ?? "errors.unexpected";
    logger.warn({ err: e, tenantId }, "assistant retention sweep skipped");
    return { ...base, skippedReason: reason };
  }
}

/**
 * Sweep every tenant that actually has conversations.
 *
 * Driving the sweep from the conversation table (not from the tenant list) keeps the
 * daily job proportional to assistant use: a deployment where nobody ever asked a
 * question visits nothing at all, and every visit is a tenant that can have work.
 * Tenants are swept one at a time, and a tenant that fails or is read-only is
 * reported in its own row instead of aborting the sweep.
 */
export async function purgeExpiredAiConversations(opts: { now?: number } = {}): Promise<AiRetentionResult[]> {
  const rows = await db
    .selectDistinct({ tenantId: aiConversations.tenantId })
    .from(aiConversations);
  const results: AiRetentionResult[] = [];
  for (const row of rows) {
    results.push(await purgeAiConversations(row.tenantId, opts));
  }
  return results;
}
