/**
 * Fiscal years & periods (ACCOUNTING_POLICY §2). Posting into a closed period
 * is impossible; missing periods are configuration errors (INV-17), not defaults.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { fiscalYears, fiscalPeriods, journalEntries } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors, isDomainError } from "@/modules/shared/result";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";

export interface FiscalPeriod {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed";
}

/** Idempotently create a calendar fiscal year with 12 monthly open periods. */
export async function ensureFiscalYear(trx: Trx, tenantId: string, year: number): Promise<void> {
  let [fy] = await trx
    .select()
    .from(fiscalYears)
    .where(and(eq(fiscalYears.tenantId, tenantId), eq(fiscalYears.name, String(year))))
    .limit(1);
  if (!fy) {
    [fy] = await trx
      .insert(fiscalYears)
      .values({
        tenantId,
        name: String(year),
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
      })
      .returning();
  }
  for (let m = 1; m <= 12; m++) {
    const name = `${year}-${String(m).padStart(2, "0")}`;
    const first = `${name}-01`;
    const lastDate = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
    const exists = await trx
      .select({ id: fiscalPeriods.id })
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.tenantId, tenantId),
          eq(fiscalPeriods.yearId, fy.id),
          eq(fiscalPeriods.name, name),
        ),
      )
      .limit(1);
    if (exists.length === 0) {
      await trx.insert(fiscalPeriods).values({
        tenantId,
        yearId: fy.id,
        name,
        startDate: first,
        endDate: lastDate,
      });
    }
  }
}

/**
 * Resolve the period for a business date and assert it's open.
 * Missing period → ConfigurationError (admin must create it).
 * Closed period → ValidationError (blocked).
 */
export async function getOpenPeriod(trx: Trx, tenantId: string, isoDate: string): Promise<FiscalPeriod> {
  const [p] = await trx
    .select({
      id: fiscalPeriods.id,
      name: fiscalPeriods.name,
      startDate: fiscalPeriods.startDate,
      endDate: fiscalPeriods.endDate,
      status: fiscalPeriods.status,
    })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        lte(fiscalPeriods.startDate, isoDate),
        gte(fiscalPeriods.endDate, isoDate),
      ),
    )
    .limit(1);
  if (!p) {
    throw errors.configuration("errors.noFiscalPeriod", `no fiscal period for ${isoDate}`, {
      businessDate: isoDate,
    });
  }
  if (p.status !== "open") {
    throw errors.validation("errors.periodClosed", `period ${p.name} closed`, { period: p.name });
  }
  return p;
}

/** Close a period: blocked while draft journals exist inside it (policy §2). */
export async function closePeriod(
  trx: Trx,
  ctx: ServiceCtx,
  periodId: string,
): Promise<void> {
  const [p] = await trx
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.tenantId, ctx.tenantId), eq(fiscalPeriods.id, periodId)))
    .limit(1);
  if (!p) throw errors.notFound("fiscalPeriod", periodId);
  if (p.status === "closed") return;

  const drafts = await trx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, ctx.tenantId),
        eq(journalEntries.status, "draft"),
        gte(journalEntries.businessDate, p.startDate),
        lte(journalEntries.businessDate, p.endDate),
      ),
    );
  if (drafts.length > 0) {
    throw errors.validation("errors.periodCloseBlockedDrafts", `${drafts.length} drafts`, {
      count: drafts.length,
      period: p.name,
    });
  }
  await trx
    .update(fiscalPeriods)
    .set({ status: "closed", closedAt: new Date(), closedBy: ctx.actorId })
    .where(eq(fiscalPeriods.id, periodId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "accounting.period.closed",
    entity: "fiscal_period",
    entityId: periodId,
    before: { status: "open", name: p.name },
    after: { status: "closed" },
  });
}

export async function reopenPeriod(trx: Trx, ctx: ServiceCtx, periodId: string): Promise<void> {
  const [p] = await trx
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.tenantId, ctx.tenantId), eq(fiscalPeriods.id, periodId)))
    .limit(1);
  if (!p) throw errors.notFound("fiscalPeriod", periodId);
  if (p.status === "open") return;
  await trx
    .update(fiscalPeriods)
    .set({ status: "open", closedAt: null, closedBy: null })
    .where(eq(fiscalPeriods.id, periodId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "accounting.period.reopened",
    entity: "fiscal_period",
    entityId: periodId,
    before: { status: "closed", name: p.name },
    after: { status: "open" },
  });
}

export function isPeriodError(e: unknown): boolean {
  return (
    isDomainError(e) &&
    ["errors.periodClosed", "errors.noFiscalPeriod", "errors.periodCloseBlockedDrafts"].includes(e.messageKey)
  );
}
