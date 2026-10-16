/**
 * AI conversation retention sweep (AI_ASSISTANT §5/§7).
 *
 * Runs the same code path as the daily `platform-maintenance` job, for when a
 * deployment wants it on demand or the worker is disabled:
 *
 *   npx tsx scripts/ai-retention.mts            # sweep every tenant with threads
 *   npx tsx scripts/ai-retention.mts --dry-run  # report what would be removed
 *
 * Deleting chat text never deletes evidence: `ai_tool_calls`, `ai_injection_flags`
 * and `ai_approval_tickets` survive with a null conversation reference.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiApprovalTickets, aiConversations, aiMessages } from "@/db/schema";
import { and, count, inArray, sql } from "drizzle-orm";
import { getAiConfig } from "@/modules/ai/config";
import { purgeAiConversations, retentionCutoff } from "@/modules/ai/retention";

async function report(dryRun: boolean) {
  const rows = await db
    .selectDistinct({ tenantId: aiConversations.tenantId })
    .from(aiConversations);
  const out: Record<string, unknown>[] = [];

  for (const row of rows) {
    const tenantId = row.tenantId;
    const config = await getAiConfig(tenantId);
    const cutoff = retentionCutoff(config.retentionDays);
    if (dryRun) {
      const [messages] = await db
        .select({ n: count() })
        .from(aiMessages)
        .where(and(eq(aiMessages.tenantId, tenantId), sql`at < ${cutoff}`));
      const [threads] = await db
        .select({ n: count() })
        .from(aiConversations)
        .where(
          and(
            eq(aiConversations.tenantId, tenantId),
            sql`coalesce(${aiConversations.lastMessageAt}, ${aiConversations.createdAt}) < ${cutoff}`,
          ),
        );
      out.push({
        tenantId,
        retentionDays: config.retentionDays,
        cutoff: cutoff.toISOString(),
        conversations: Number(threads?.n ?? 0),
        messages: Number(messages?.n ?? 0),
        dryRun: true,
      });
      continue;
    }
    const result = await purgeAiConversations(tenantId);
    out.push(result as unknown as Record<string, unknown>);
  }

  if (out.length === 0) {
    console.log("no conversations to consider — every tenant is clear");
    return;
  }
  console.table(out);
  const removed = out.reduce((a, r) => a + Number(r.conversations ?? 0), 0);
  const skipped = out.filter((r) => r.skippedReason).length;
  console.log(
    `${dryRun ? "would remove" : "removed"} ${removed} conversation(s) across ${out.length} tenant(s)` +
      (skipped ? `; ${skipped} tenant(s) skipped (read-only or failing)` : ""),
  );

  // a ticket is never swept, so the script states that plainly instead of leaving
  // the operator to wonder whether chat retention touched accounting evidence
  const [ticketTotal] = await db.select({ n: count() }).from(aiApprovalTickets);
  console.log(`approval tickets retained: ${ticketTotal?.n ?? 0}`);
}

const dryRun = process.argv.includes("--dry-run");
report(dryRun)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
