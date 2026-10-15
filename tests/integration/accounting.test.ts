/**
 * Accounting foundations (Phase 2) — INV-01/02/03/04, closed periods, INV-17.
 * Environment-limited: runs when DATABASE_URL is set and seeds are applied.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("accounting — posting engine invariants", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  let tenantA = "";
  let tenantB = "";
  let actorId = "";
  let accounts: Record<string, string> = {};

  async function accountCodes(tenantId: string): Promise<Record<string, string>> {
    const r = (await db.execute(
      sql`select code, id from accounts where tenant_id = ${tenantId}`,
    )) as unknown as { rows: { code: string; id: string }[] };
    return Object.fromEntries(r.rows.map((x) => [x.code, x.id]));
  }

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    ({ withTenant } = await import("@/modules/shared/db-context"));
    ({ newId } = await import("@/modules/shared/ids"));
    const t = (await db.execute(sql`select id from tenants order by created_at asc limit 2`)) as unknown as {
      rows: { id: string }[];
    };
    tenantA = t.rows[0].id;
    tenantB = t.rows[1].id;
    const u = (await db.execute(
      sql`select id from users where tenant_id = ${tenantA} order by created_at asc limit 1`,
    )) as unknown as { rows: { id: string }[] };
    actorId = u.rows[0].id;
    accounts = await accountCodes(tenantA);

    // ensure fiscal basics (seed may already have run)
    const { ensureFiscalYear } = await import("@/modules/accounting/periods");
    await withTenant(tenantA, (trx) => ensureFiscalYear(trx, tenantA, 2026));
    await withTenant(tenantB, (trx) => ensureFiscalYear(trx, tenantB, 2026));
    const { ensureMappings } = await import("@/modules/accounting/coa");
    await withTenant(tenantA, (trx) => ensureMappings(trx, tenantA));
    await withTenant(tenantB, (trx) => ensureMappings(trx, tenantB));
  });

  const balancedLines = () => [
    { accountId: accounts["1101"], debit: "115.00", credit: "0" },
    { accountId: accounts["4101"], debit: "0", credit: "115.00" },
  ];

  it("posts a balanced entry exactly once; identical retry is a replay (INV-01/02)", async () => {
    const { postEntry } = await import("@/modules/accounting/posting");
    const sourceId = newId();
    const ctx = { tenantId: tenantA, actorId };

    const first = await withTenant(tenantA, (trx) =>
      postEntry(trx, ctx, {
        sourceType: "test",
        sourceId,
        businessDate: "2026-03-05",
        memo: "اختبار الترحيل المتكرر",
        lines: balancedLines(),
      }),
    );
    expect(first.status).toBe("posted");
    expect(first.entryNo).toBeTypeOf("number");
    expect(first.replayed).toBe(false);

    const second = await withTenant(tenantA, (trx) =>
      postEntry(trx, ctx, {
        sourceType: "test",
        sourceId,
        businessDate: "2026-03-05",
        memo: "اختبار الترحيل المتكرر",
        lines: balancedLines(),
      }),
    );
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    const cnt = (await db.execute(
      sql`select count(*)::int as n from journal_entries where source_type = 'test' and source_id = ${sourceId}`,
    )) as unknown as { rows: { n: number }[] };
    expect(cnt.rows[0].n).toBe(1);
  });

  it("rejects an unbalanced entry (INV-01 service-side)", async () => {
    const { postEntry } = await import("@/modules/accounting/posting");
    const { isDomainError } = await import("@/modules/shared/result");
    const ctx = { tenantId: tenantA, actorId };
    const err = await withTenant(tenantA, (trx) =>
      postEntry(trx, ctx, {
        sourceType: "test",
        sourceId: newId(),
        businessDate: "2026-03-05",
        lines: [
          { accountId: accounts["1101"], debit: "100", credit: "0" },
          { accountId: accounts["4101"], debit: "0", credit: "99" },
        ],
      }),
    ).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect(err.messageKey).toBe("errors.journalNotBalanced");
  });

  it("two concurrent posts of one draft → a single posted entry/number (INV-02/15)", async () => {
    const { createDraftManual, postDraft } = await import("@/modules/accounting/posting");
    const ctx = { tenantId: tenantA, actorId };
    const draft = await withTenant(tenantA, (trx) =>
      createDraftManual(trx, ctx, {
        businessDate: "2026-03-06",
        memo: "مسودة سباق ترحيل",
        lines: balancedLines(),
      }),
    );

    const results = await Promise.allSettled([
      withTenant(tenantA, (trx) => postDraft(trx, ctx, draft.id)),
      withTenant(tenantA, (trx) => postDraft(trx, ctx, draft.id)),
    ]);
    type PostedEntry = import("@/modules/accounting/posting").PostedEntry;
    const okResults = results
      .filter((r): r is PromiseFulfilledResult<PostedEntry> => r.status === "fulfilled")
      .map((r) => r.value);
    expect(okResults.length).toBe(2);
    expect(new Set(okResults.map((r) => r.id)).size).toBe(1);
    const numbers = okResults.map((r) => r.entryNo).filter((n) => n != null);
    expect(new Set(numbers).size).toBe(1);

    const status = (await db.execute(
      sql`select status from journal_entries where id = ${draft.id}`,
    )) as unknown as { rows: { status: string }[] };
    expect(status.rows[0].status).toBe("posted");
  });

  it("blocked: posting into a closed period — service and DB trigger (AC-020)", async () => {
    const { closePeriod, reopenPeriod } = await import("@/modules/accounting/periods");
    const { postEntry } = await import("@/modules/accounting/posting");
    const { isDomainError } = await import("@/modules/shared/result");
    const ctxB = { tenantId: tenantB, actorId: null };

    const periodRow = (await db.execute(
      sql`select id from fiscal_periods where tenant_id = ${tenantB} and name = '2026-02' limit 1`,
    )) as unknown as { rows: { id: string }[] };
    const periodId = periodRow.rows[0].id;

    // resilient: clear any leftover drafts from interrupted prior runs
    await db.execute(
      sql`delete from journal_entries where tenant_id = ${tenantB} and status = 'draft' and business_date between '2026-02-01' and '2026-02-28'`,
    );
    await db.execute(sql`update fiscal_periods set status = 'open' where id = ${periodId}`);
    await withTenant(tenantB, (trx) => closePeriod(trx, ctxB, periodId));

    const acctsB = await accountCodes(tenantB);
    const err = await withTenant(tenantB, (trx) =>
      postEntry(trx, ctxB, {
        sourceType: "test",
        sourceId: newId(),
        businessDate: "2026-02-10",
        lines: [
          { accountId: acctsB["1101"], debit: "50", credit: "0" },
          { accountId: acctsB["4101"], debit: "0", credit: "50" },
        ],
      }),
    ).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect(err.messageKey).toBe("errors.periodClosed");

    // DB-level trigger proof: even bypassing the service, posted rows in a closed period fail
    const { createDraftManual } = await import("@/modules/accounting/posting");
    const draft = await withTenant(tenantB, (trx) =>
      createDraftManual(trx, ctxB, {
        businessDate: "2026-02-10",
        memo: "إثبات المشغّل",
        lines: [
          { accountId: acctsB["1101"], debit: "10", credit: "0" },
          { accountId: acctsB["4101"], debit: "0", credit: "10" },
        ],
      }),
    );
    const triggerErr: unknown = await db
      .execute(
        sql`update journal_entries set status = 'posted', entry_no = 99001, period_id = ${periodId} where id = ${draft.id}`,
      )
      .catch((x: unknown) => x);
    expect(triggerErr instanceof Error).toBe(true);
    // Drizzle wraps the pg error — the invariant message lives in the cause chain.
    let chain: unknown = triggerErr;
    let text = "";
    while (chain && typeof chain === "object") {
      text += (chain as { message?: string }).message ?? "";
      chain = (chain as { cause?: unknown }).cause;
    }
    expect(text).toMatch(/not open for posting/i);

    await db.execute(sql`delete from journal_entries where id = ${draft.id}`); // draft cleanup allowed
    await withTenant(tenantB, (trx) => reopenPeriod(trx, ctxB, periodId));
    const reopened = (await db.execute(
      sql`select status from fiscal_periods where id = ${periodId}`,
    )) as unknown as { rows: { status: string }[] };
    expect(reopened.rows[0].status).toBe("open");
  });

  it("missing posting mapping → blocking ConfigurationError (INV-17)", async () => {
    const { removeMappingForTest, ensureMappings } = await import("@/modules/accounting/coa");
    const { resolveMappingId } = await import("@/modules/accounting/mappings");
    const { isDomainError } = await import("@/modules/shared/result");

    await withTenant(tenantB, async (trx) => {
      await removeMappingForTest(trx, tenantB, "sales");
      const err = await resolveMappingId(trx, tenantB, "sales").catch((e) => e);
      expect(isDomainError(err)).toBe(true);
      expect(err.kind).toBe("ConfigurationError");
      expect(err.messageKey).toBe("errors.missingMapping");
      await ensureMappings(trx, tenantB); // restore
    });
  });

  it("reversal: separate linked entry, unique per original (INV-04)", async () => {
    const { postEntry, reverseEntry } = await import("@/modules/accounting/posting");
    const { isDomainError } = await import("@/modules/shared/result");
    const ctx = { tenantId: tenantA, actorId };

    const original = await withTenant(tenantA, (trx) =>
      postEntry(trx, ctx, {
        sourceType: "test",
        sourceId: newId(),
        businessDate: "2026-03-07",
        memo: "قيد لعكسه",
        lines: balancedLines(),
      }),
    );

    const reversal = await withTenant(tenantA, (trx) =>
      reverseEntry(trx, ctx, original.id, "2026-03-08"),
    );
    expect(reversal.status).toBe("posted");

    const revLines = (await db.execute(
      sql`select debit::text, credit::text from journal_lines where entry_id = ${reversal.id} order by line_no`,
    )) as unknown as { rows: { debit: string; credit: string }[] };
    expect(revLines.rows[0].debit).toBe("0.0000");
    expect(revLines.rows[0].credit).toBe("115.0000");

    const second = await withTenant(tenantA, (trx) =>
      reverseEntry(trx, ctx, original.id, "2026-03-08"),
    ).catch((e) => e);
    expect(isDomainError(second)).toBe(true);
    expect(second.kind).toBe("ConflictError");
  });

  it("posted entries are immutable at DB level (INV-03)", async () => {
    const { postEntry } = await import("@/modules/accounting/posting");
    const ctx = { tenantId: tenantA, actorId };
    const e = await withTenant(tenantA, (trx) =>
      postEntry(trx, ctx, {
        sourceType: "test",
        sourceId: newId(),
        businessDate: "2026-03-09",
        memo: "قيد للتلاعب",
        lines: balancedLines(),
      }),
    );
    const updErr = await db
      .execute(sql`update journal_entries set memo = 'تلاعب' where id = ${e.id}`)
      .catch((x) => x as Error);
    expect(updErr).toBeInstanceOf(Error);
    const delErr = await db
      .execute(sql`delete from journal_entries where id = ${e.id}`)
      .catch((x) => x as Error);
    expect(delErr).toBeInstanceOf(Error);
  });
});
