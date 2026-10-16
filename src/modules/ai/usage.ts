/**
 * Assistant usage metering (AI_ASSISTANT §7, PLATFORM_ADMIN §3).
 *
 * What lands in `usage_metrics` is **counts only**: turns, tokens, tool calls,
 * refusals, injection hits. No question text, no answer text, and never a tenant
 * figure — the platform side of the product is allowed to see that the assistant
 * is used, not what it was asked or what it answered.
 *
 * Metering must never break an answer: a provider reply that already cost money is
 * not thrown away because a counter failed to increment. Failures are logged.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { usageMetrics } from "@/db/schema";
import { logger } from "@/modules/shared/logger";
import { monthOf, todayBusinessDate } from "@/modules/shared/dates";

/** Metric keys the assistant writes. Kept in one place so the console can list them. */
export const AI_METRICS = [
  "ai_turns",
  "ai_tokens_in",
  "ai_tokens_out",
  "ai_tool_calls",
  "ai_refusals",
  "ai_injection_flags",
] as const;
export type AiMetric = (typeof AI_METRICS)[number];

export interface AiUsageSample {
  turns?: number;
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: number;
  refusals?: number;
  injectionFlags?: number;
}

/**
 * Additive upsert of one usage sample.
 *
 * Additive on purpose: `recordUsage` (platform) *sets* a snapshot value, while a
 * token count is a flow that accumulates within the period. Mixing the two would
 * silently rewrite a month's total with a single turn's numbers.
 */
export async function addUsage(tenantId: string, metric: string, period: string, increment: number): Promise<void> {
  if (!Number.isFinite(increment) || increment === 0) return;
  await db
    .insert(usageMetrics)
    .values({ tenantId, metric, period, value: String(increment) })
    .onConflictDoUpdate({
      target: [usageMetrics.tenantId, usageMetrics.metric, usageMetrics.period],
      set: {
        value: sql`${usageMetrics.value} + ${String(increment)}::numeric`,
        capturedAt: new Date(),
      },
    });
}

/** Record one assistant turn's counters for the tenant's business month. */
export async function recordAiUsage(tenantId: string, sample: AiUsageSample): Promise<void> {
  const period = monthOf(todayBusinessDate());
  const entries: [AiMetric, number][] = [
    ["ai_turns", sample.turns ?? 0],
    ["ai_tokens_in", sample.tokensIn ?? 0],
    ["ai_tokens_out", sample.tokensOut ?? 0],
    ["ai_tool_calls", sample.toolCalls ?? 0],
    ["ai_refusals", sample.refusals ?? 0],
    ["ai_injection_flags", sample.injectionFlags ?? 0],
  ];
  try {
    for (const [metric, value] of entries) {
      if (value > 0) await addUsage(tenantId, metric, period, value);
    }
  } catch (err) {
    logger.warn({ err, tenantId }, "assistant usage metering failed (answer unaffected)");
  }
}

/** Current-month assistant counters, for the tenant screen and the platform console. */
export async function aiUsageSnapshot(
  tenantId: string,
  month = monthOf(todayBusinessDate()),
): Promise<Record<AiMetric, number>> {
  const rows = await db
    .select({ metric: usageMetrics.metric, value: usageMetrics.value })
    .from(usageMetrics)
    .where(sql`${usageMetrics.tenantId} = ${tenantId}::uuid and ${usageMetrics.period} = ${month}`);
  const out = Object.fromEntries(AI_METRICS.map((m) => [m, 0])) as Record<AiMetric, number>;
  for (const row of rows) {
    if ((AI_METRICS as readonly string[]).includes(row.metric)) {
      out[row.metric as AiMetric] = Number(row.value);
    }
  }
  return out;
}
