"use server";

/** Accounting server actions — permission-checked entry points (SEC §4). */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { requirePermission, serviceCtxOf, type ServiceCtx } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { todayBusinessDate } from "@/modules/shared/dates";
import { newId } from "@/modules/shared/ids";
import { createDraftManual, postDraft, postEntry, reverseEntry } from "./posting";
import { closePeriod, reopenPeriod } from "./periods";
import { postingMappings } from "@/db/schema";
import { and, eq } from "drizzle-orm";

import type { ActionResult } from "@/modules/shared/action-result";

type Runner = (trx: Trx, ctx: ServiceCtx) => Promise<void | string>;

async function run(permission: string, fn: Runner): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  try {
    requirePermission(ctx, permission);
    const svc = serviceCtxOf(ctx);
    const okKey = await withTenant(ctx.tenant.id, (trx) => fn(trx, svc));
    revalidatePath("/accounting");
    revalidatePath("/dashboard");
    return { ok: true, okKey: typeof okKey === "string" ? okKey : undefined };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey };
    logger.error({ err: e }, "accounting action failed");
    return { ok: false, errorKey: "errors.unexpected" };
  }
}

const journalLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.string().default("0"),
  credit: z.string().default("0"),
  memo: z.string().nullish(),
});

const createJournalSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(500).optional(),
  linesJson: z.string(),
  intent: z.enum(["draft", "post"]),
});

export async function createJournalAction(formData: FormData): Promise<ActionResult> {
  const parsed = createJournalSchema.safeParse({
    businessDate: formData.get("businessDate"),
    memo: formData.get("memo") || undefined,
    linesJson: formData.get("linesJson"),
    intent: formData.get("intent"),
  });
  if (!parsed.success) return { ok: false, errorKey: "errors.loginInvalidInput" };
  const linesParsed = z.array(journalLineSchema).min(2).safeParse(JSON.parse(parsed.data.linesJson));
  if (!linesParsed.success) return { ok: false, errorKey: "errors.journalNeedsTwoLines" };

  const intent = parsed.data.intent;
  return run(
    intent === "post" ? "accounting.journal.post" : "accounting.journal.create",
    async (trx, ctx) => {
      const input = {
        businessDate: parsed.data.businessDate,
        memo: parsed.data.memo ?? null,
        lines: linesParsed.data.map((l) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo ?? null,
        })),
      };
      if (intent === "draft") {
        await createDraftManual(trx, ctx, input);
        return "accounting.journalCreated";
      }
      const id = newId();
      await postEntry(trx, ctx, {
        sourceType: "manual",
        sourceId: id,
        effectKind: "post",
        memo: input.memo,
        businessDate: input.businessDate,
        lines: input.lines,
      });
      return "accounting.journalPosted";
    },
  );
}

export async function postJournalAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("entryId") ?? "");
  return run("accounting.journal.post", async (trx, ctx) => {
    await postDraft(trx, ctx, id);
    return "accounting.journalPosted";
  });
}

export async function reverseJournalAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("entryId") ?? "");
  return run("accounting.journal.reverse", async (trx, ctx) => {
    let tz = "Asia/Riyadh";
    const r = await trx.execute(sql`select timezone from companies where tenant_id = ${ctx.tenantId}`);
    tz = (r as unknown as { rows: { timezone: string }[] }).rows[0]?.timezone ?? tz;
    await reverseEntry(trx, ctx, id, todayBusinessDate(tz));
    return "accounting.journalReversed";
  });
}

export async function closePeriodAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("periodId") ?? "");
  return run("accounting.period.manage", async (trx, ctx) => {
    await closePeriod(trx, ctx, id);
  });
}

export async function reopenPeriodAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("periodId") ?? "");
  return run("accounting.period.manage", async (trx, ctx) => {
    await reopenPeriod(trx, ctx, id);
  });
}

export async function saveMappingAction(formData: FormData): Promise<ActionResult> {
  const key = String(formData.get("key") ?? "");
  const accountId = String(formData.get("accountId") ?? "");
  return run("accounting.mappings.manage", async (trx, ctx) => {
    await trx
      .insert(postingMappings)
      .values({ tenantId: ctx.tenantId, key, accountId })
      .onConflictDoUpdate({
        target: [postingMappings.tenantId, postingMappings.key],
        set: { accountId, updatedAt: new Date() },
      });
    return "accounting.mappingSaved";
  });
}

/** Helper for UI: fetch existing mapping value. */
export async function getMappingFor(trx: Trx, tenantId: string, key: string) {
  const [row] = await trx
    .select()
    .from(postingMappings)
    .where(and(eq(postingMappings.tenantId, tenantId), eq(postingMappings.key, key)))
    .limit(1);
  return row ?? null;
}
