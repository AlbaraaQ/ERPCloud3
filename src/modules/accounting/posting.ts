/**
 * PostingService — the ONLY way journal entries are created (D-006).
 * Guarantees:
 *  - balanced lines, HALF_UP rounded (INV-01, D-003) — service + DB trigger
 *  - idempotency by unique (tenant, source_type, source_id, effect_kind) (INV-02)
 *  - entry numbers assigned at posting time under a row lock (D-005)
 *  - posting only into open periods (service + trigger)
 *  - posted rows immutable; reversals are separate, unique-per-original entries
 */

import { and, eq, sql } from "drizzle-orm";
import {
  journalEntries,
  journalLines,
  documentCounters,
  accounts,
} from "@/db/schema";
import { db } from "@/db";
import type { Trx } from "@/modules/shared/db-context";
import {
  errors, isDomainError, DomainError,
} from "@/modules/shared/result";
import { dec, roundMoney, toDb, isZero, isNegative, sum } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { getOpenPeriod } from "./periods";

export interface PostingLine {
  accountId: string;
  debit?: string;
  credit?: string;
  branchId?: string | null;
  warehouseId?: string | null;
  representativeId?: string | null;
  costCenter?: string | null;
  project?: string | null;
  memo?: string | null;
}

export interface PostingInput {
  sourceType: string; // e.g. "manual", "sales_invoice", "opening"
  sourceId: string;
  effectKind?: string; // default "post"
  businessDate: string; // ISO YYYY-MM-DD (tenant tz)
  memo?: string | null;
  reversalOf?: string | null;
  lines: PostingLine[];
}

export interface PostedEntry {
  id: string;
  entryNo: number | null;
  status: "draft" | "posted";
  businessDate: string;
  memo: string | null;
  replayed: boolean;
}

/** Walk the error cause chain (Drizzle wraps pg errors) for a pg error code. */
function pgErrorInfo(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e;
  const out: { code?: string; constraint?: string } = {};
  while (cur && typeof cur === "object") {
    const c = cur as { code?: string; constraint?: string; cause?: unknown };
    out.code ??= c.code;
    out.constraint ??= c.constraint;
    if (out.code) break;
    cur = c.cause;
  }
  return out;
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const { code, constraint: name } = pgErrorInfo(e);
  return code === "23505" && String(name ?? "").includes(constraint);
}

/** Validate lines and return {totalDr, totalCr} rounded to currency. */
function validateLines(lines: PostingLine[], currency: string) {
  if (!lines || lines.length < 2) {
    throw errors.validation("errors.journalNeedsTwoLines", undefined, { count: lines?.length ?? 0 });
  }
  for (const [i, l] of lines.entries()) {
    const d = dec(l.debit ?? 0);
    const c = dec(l.credit ?? 0);
    if (isNegative(d) || isNegative(c)) {
      throw errors.validation("errors.journalNegativeAmount", undefined, { line: i + 1 });
    }
    if ((isZero(d) && isZero(c)) || (!isZero(d) && !isZero(c))) {
      throw errors.validation("errors.journalLineOneSide", undefined, { line: i + 1 });
    }
  }
  const totalDr = roundMoney(sum(lines.map((l) => l.debit ?? 0)), currency);
  const totalCr = roundMoney(sum(lines.map((l) => l.credit ?? 0)), currency);
  if (totalDr.isZero() || !totalDr.eq(totalCr)) {
    throw errors.validation(
      "errors.journalNotBalanced",
      `dr=${toDb(totalDr)} cr=${toDb(totalCr)}`,
      { dr: toDb(totalDr), cr: toDb(totalCr) },
    );
  }
  return { totalDr, totalCr };
}

/** Posting-time, gapless, per-series number under a row lock (D-005). */
export async function nextDocNumber(trx: Trx, tenantId: string, series: string): Promise<number> {
  await trx
    .insert(documentCounters)
    .values({ tenantId, series, value: 0 })
    .onConflictDoNothing();
  await trx.execute(
    sql`select 1 from document_counters where tenant_id = ${tenantId} and series = ${series} for update`,
  );
  const [row] = await trx
    .select({ value: documentCounters.value })
    .from(documentCounters)
    .where(and(eq(documentCounters.tenantId, tenantId), eq(documentCounters.series, series)));
  const next = Number(row.value) + 1;
  await trx
    .update(documentCounters)
    .set({ value: next })
    .where(and(eq(documentCounters.tenantId, tenantId), eq(documentCounters.series, series)));
  return next;
}

async function validateAccounts(trx: Trx, tenantId: string, lines: PostingLine[]): Promise<void> {
  for (const [i, l] of lines.entries()) {
    const [a] = await trx
      .select({ id: accounts.id, isGroup: accounts.isGroup, active: accounts.active })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, l.accountId)))
      .limit(1);
    if (!a) throw errors.validation("errors.accountNotFound", l.accountId, { line: i + 1 });
    if (!a.active) throw errors.validation("errors.accountInactive", undefined, { line: i + 1 });
    if (a.isGroup) throw errors.validation("errors.accountIsGroup", undefined, { line: i + 1 });
  }
}

/**
 * Core poster. Runs inside the caller's tenant transaction. On idempotent
 * replay returns the existing posted entry with `replayed: true` (INV-02).
 */
export async function postEntry(
  trx: Trx,
  ctx: ServiceCtx,
  input: PostingInput,
  currency = "SAR",
): Promise<PostedEntry> {
  const { totalDr } = validateLines(input.lines, currency);
  await validateAccounts(trx, ctx.tenantId, input.lines);
  const period = await getOpenPeriod(trx, ctx.tenantId, input.businessDate);

  const entryId = newId();
  const effect = input.effectKind ?? "post";
  let entryNo: number | null = null;
  // Savepoint: PG aborts a transaction on any error; rollback-to-savepoint
  // lets us convert a source-uniqueness conflict into an idempotent replay.
  const sp = `hisab_post_${newId().replace(/-/g, "").slice(0, 12)}`;
  await trx.execute(sql`savepoint ${sql.raw(sp)}`);
  try {
    await trx.insert(journalEntries).values({
      id: entryId,
      tenantId: ctx.tenantId,
      status: "draft",
      businessDate: input.businessDate,
      memo: input.memo ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      effectKind: effect,
      reversalOf: input.reversalOf ?? null,
      createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
    });
    await trx.insert(journalLines).values(
      input.lines.map((l, i) => ({
        id: newId(),
        tenantId: ctx.tenantId,
        entryId,
        lineNo: i + 1,
        accountId: l.accountId,
        debit: toDb(dec(l.debit ?? 0)),
        credit: toDb(dec(l.credit ?? 0)),
        branchId: l.branchId ?? null,
        warehouseId: l.warehouseId ?? null,
        representativeId: l.representativeId ?? null,
        costCenter: l.costCenter ?? null,
        project: l.project ?? null,
        memo: l.memo ?? null,
      })),
    );

    entryNo = await nextDocNumber(trx, ctx.tenantId, "JV");
    const [posted] = await trx
      .update(journalEntries)
      .set({
        status: "posted",
        entryNo,
        periodId: period.id,
        postedAt: new Date(),
        postedBy: ctx.actorId,
      })
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.status, "draft")))
      .returning({ id: journalEntries.id, entryNo: journalEntries.entryNo });
    if (!posted) {
      throw errors.invariant("postEntry: conditional update failed", { entryId });
    }
  } catch (e) {
    if (isUniqueViolation(e, "journal_source_uq")) {
      await trx.execute(sql`rollback to savepoint ${sql.raw(sp)}`);
      const [existing] = await trx
        .select({ id: journalEntries.id, entryNo: journalEntries.entryNo, businessDate: journalEntries.businessDate, memo: journalEntries.memo })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.tenantId, ctx.tenantId),
            eq(journalEntries.sourceType, input.sourceType),
            eq(journalEntries.sourceId, input.sourceId),
            eq(journalEntries.effectKind, effect),
          ),
        )
        .limit(1);
      if (existing) {
        return { ...existing, memo: existing.memo ?? null, status: "posted", replayed: true };
      }
    }
    throw e;
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "accounting.journal.posted",
    entity: "journal_entry",
    entityId: entryId,
    after: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      effect,
      total: toDb(totalDr),
    },
  });

  return { id: entryId, entryNo, status: "posted", businessDate: input.businessDate, memo: input.memo ?? null, replayed: false };
}

/** Create a manual draft (no effects; D-005: no official number yet). */
export async function createDraftManual(
  trx: Trx,
  ctx: ServiceCtx,
  input: Omit<PostingInput, "sourceType" | "sourceId" | "effectKind">,
  currency = "SAR",
): Promise<PostedEntry> {
  validateLines(input.lines, currency);
  await validateAccounts(trx, ctx.tenantId, input.lines);
  const id = newId();
  await trx.insert(journalEntries).values({
    id,
    tenantId: ctx.tenantId,
    status: "draft",
    businessDate: input.businessDate,
    memo: input.memo ?? null,
    sourceType: "manual",
    sourceId: id,
    effectKind: "post",
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
  await trx.insert(journalLines).values(
    input.lines.map((l, i) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      entryId: id,
      lineNo: i + 1,
      accountId: l.accountId,
      debit: toDb(dec(l.debit ?? 0)),
      credit: toDb(dec(l.credit ?? 0)),
      branchId: l.branchId ?? null,
      warehouseId: l.warehouseId ?? null,
      representativeId: l.representativeId ?? null,
      costCenter: l.costCenter ?? null,
      project: l.project ?? null,
      memo: l.memo ?? null,
    })),
  );
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "accounting.journal.draft_created",
    entity: "journal_entry",
    entityId: id,
  });
  return { id, entryNo: null, status: "draft", businessDate: input.businessDate, memo: input.memo ?? null, replayed: false };
}

/**
 * Post an existing manual draft. Concurrency-safe: the conditional update
 * (status='draft') guarantees exactly one poster wins; losers get the same
 * posted entry (INV-02).
 */
export async function postDraft(
  trx: Trx,
  ctx: ServiceCtx,
  entryId: string,
  currency = "SAR",
): Promise<PostedEntry> {
  const [entry] = await trx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.id, entryId)))
    .limit(1);
  if (!entry) throw errors.notFound("journalEntry", entryId);
  if (entry.status === "posted") return { ...entry, replayed: true };

  const lines = await trx
    .select({ debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .where(eq(journalLines.entryId, entryId));
  validateLines(
    lines.map((l) => ({ accountId: "x", debit: l.debit, credit: l.credit })),
    currency,
  );
  const period = await getOpenPeriod(trx, ctx.tenantId, entry.businessDate);
  const entryNo = await nextDocNumber(trx, ctx.tenantId, "JV");

  const [posted] = await trx
    .update(journalEntries)
    .set({
      status: "posted",
      entryNo,
      periodId: period.id,
      postedAt: new Date(),
      postedBy: ctx.actorId,
    })
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.status, "draft")))
    .returning({ id: journalEntries.id, entryNo: journalEntries.entryNo });
  if (!posted) {
    // lost the race — return the (now) posted entry
    return { ...entry, status: "posted", replayed: true };
  }
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "accounting.journal.posted",
    entity: "journal_entry",
    entityId: entryId,
    after: { entryNo },
  });
  return { id: entryId, entryNo, status: "posted", businessDate: entry.businessDate, memo: entry.memo, replayed: false };
}

/**
 * Reverse a posted entry (INV-04): separate entry, linked & unique per
 * original; reversal date determines the (open) period (policy §6).
 */
export async function reverseEntry(
  trx: Trx,
  ctx: ServiceCtx,
  entryId: string,
  reversalDate: string,
  memo?: string,
  currency = "SAR",
): Promise<PostedEntry> {
  const [original] = await trx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.id, entryId)))
    .limit(1);
  if (!original) throw errors.notFound("journalEntry", entryId);
  if (original.status !== "posted") {
    throw errors.validation("errors.reverseOnlyPosted", undefined, { status: original.status });
  }

  const [existingReversal] = await trx
    .select({ id: journalEntries.id, entryNo: journalEntries.entryNo, businessDate: journalEntries.businessDate, memo: journalEntries.memo })
    .from(journalEntries)
    .where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.reversalOf, entryId)))
    .limit(1);
  if (existingReversal) {
    throw errors.conflict("errors.alreadyReversed", entryId, { reversalId: existingReversal.id });
  }

  const lines = await trx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, entryId));

  try {
    const posted = await postEntry(
      trx,
      ctx,
      {
        sourceType: "journal.reversal",
        sourceId: entryId,
        effectKind: "post",
        businessDate: reversalDate,
        memo: memo ?? `عكس القيد ${original.entryNo ?? ""}`.trim(),
        reversalOf: entryId,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit ?? "0",
          credit: l.debit ?? "0",
          branchId: l.branchId,
          warehouseId: l.warehouseId,
          representativeId: l.representativeId,
          costCenter: l.costCenter,
          project: l.project,
          memo: l.memo,
        })),
      },
      currency,
    );
    await writeAudit(trx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.actorId,
      actorLabel: ctx.actorId ?? "system",
      action: "accounting.journal.reversed",
      entity: "journal_entry",
      entityId: entryId,
      after: { reversalId: posted.id },
    });
    return posted;
  } catch (e) {
    if (isUniqueViolation(e, "journal_reversal_uq") || (isDomainError(e) && e.kind === "ConflictError")) {
      throw errors.conflict("errors.alreadyReversed", entryId);
    }
    throw e;
  }
}

export { DomainError, isDomainError };
export const __testables = { validateLines };
