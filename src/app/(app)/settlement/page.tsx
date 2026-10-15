import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission, hasPermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import { sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { SettlementReview } from "./review";
import { Scale, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "التسويات" };

export default async function SettlementsPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "settlement.review");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const list = (await trx.execute(sql`
      select s.id, s.settlement_no, s.status, s.business_date, s.rep_user_id,
             u.name as rep_name, s.expected_cash::text, s.counted_cash::text,
             s.reviewed_at, s.closed_at
      from settlements s join users u on u.id = s.rep_user_id
      where s.tenant_id = ${ctx.tenant!.id} and s.status <> 'closed'
      order by s.created_at desc limit 20
    `)) as unknown as { rows: any[] };
    const closed = (await trx.execute(sql`
      select s.id, s.settlement_no, s.business_date, u.name as rep_name, s.counted_cash::text, s.closed_at
      from settlements s join users u on u.id = s.rep_user_id
      where s.tenant_id = ${ctx.tenant!.id} and s.status = 'closed'
      order by s.closed_at desc limit 10
    `)) as unknown as { rows: any[] };
    return { list: list.rows, closed: closed.rows };
  });

  const { settlementLines, settlementExceptions } = await import("@/db/schema");

  const details: Record<string, { lines: any[]; exceptions: any[] }> = {};
  for (const s of data.list) {
    if (s.status !== "under_review") continue;
    const [lines, exceptions] = await Promise.all([
      withTenant(ctx.tenant.id, (trx) =>
        trx
          .select({
            productId: settlementLines.productId,
            expectedQty: settlementLines.expectedQty,
            countedQty: settlementLines.countedQty,
            diffQty: settlementLines.diffQty,
          })
          .from(settlementLines)
          .where(eq(settlementLines.settlementId, s.id)),
      ),
      withTenant(ctx.tenant.id, (trx) =>
        trx
          .select()
          .from(settlementExceptions)
          .where(eq(settlementExceptions.settlementId, s.id)),
      ),
    ]);
    details[s.id] = { lines, exceptions };
  }

  const statusLabel = (s: string) =>
    s === "requested" ? t.rep.sRequested : s === "under_review" ? t.rep.sReview : t.rep.sClosed;
  const canFinalize = hasPermission(ctx, "settlement.finalize");
  const canApproveException = hasPermission(ctx, "settlement.exception.approve");

  return (
    <div className="space-y-8">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <Scale className="h-6 w-6 text-primary" /> {t.rep.rqTitle}
      </h1>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t.rep.openSettlements}</h2>
        {data.list.length === 0 && (
          <div className="card p-8 text-center text-sm text-muted">{t.common.empty}</div>
        )}
        {data.list.map((s) => (
          <div key={s.id} className="space-y-0">
            <SettlementReview
              t={t}
              errors={errorsFlat}
              settlement={{
                id: s.id,
                settlementNo: s.settlement_no,
                status: s.status,
                businessDate: s.business_date,
                repName: s.rep_name,
                expectedCash: s.expected_cash,
                countedCash: s.counted_cash,
              }}
              lines={(details[s.id]?.lines ?? []).map((l: any) => ({
                productId: l.productId,
                expectedQty: l.expectedQty,
                countedQty: l.countedQty,
              }))}
              exceptions={(details[s.id]?.exceptions ?? []).map((e: any) => ({
                id: e.id,
                kind: e.kind,
                entity: e.entity,
                diff: e.diff,
                note: e.note,
                resolution: e.resolution,
              }))}
              canFinalize={canFinalize}
              canApproveException={canApproveException}
              statusLabel={statusLabel(s.status)}
            />
          </div>
        ))}
      </section>

      {data.closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t.rep.sClosed}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.closed.map((s) => (
              <div key={s.id} className="card flex items-start justify-between p-4">
                <div>
                  <p className="font-semibold">{t.rep.settlementNo} #{s.settlement_no}</p>
                  <p className="text-xs text-muted">{s.rep_name} · <span dir="ltr">{s.business_date}</span></p>
                  <p className="tnum mt-1 text-sm" dir="ltr">{(+s.counted_cash).toFixed(2)} {t.common.sar}</p>
                </div>
                <CheckCircle2 className="h-5 w-5 text-success" />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
