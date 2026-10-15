/**
 * Platform console dashboard (PLATFORM_ADMIN §1).
 *
 * Monitoring only: tenant **status** counts, subscription/MRR **declared**
 * figures, usage counters, queue depth, and backup freshness — the one number
 * that must never be silently zero. No invoice content, no tenant amounts.
 */

import { count, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  backupRuns,
  deletionRequests,
  platformAlerts,
  supportGrants,
  tenantExports,
  tenants,
  usageMetrics,
} from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
import { getPlatformContext } from "@/modules/platform/context";
import { tenantStatusCounts } from "@/modules/platform/tenants";
import { backupFreshness, artifactInventory, listBackupRuns } from "@/modules/platform/backup/service";
import { getSettings } from "@/modules/platform/settings";
import { getWorkerStatus } from "@/modules/jobs/worker";
import type { PlatformContext } from "@/modules/platform/context";

/** Identity of the acting operator — the page is only reachable behind the guard. */
function actorLabelOf(ctx: PlatformContext | null): string {
  return ctx ? `${ctx.name} <${ctx.email}>` : "platform";
}
import { Badge, StatCard, fmtBytes, fmtDate, statusTone } from "../ui";

export const dynamic = "force-dynamic";

export default async function PlatformDashboard() {
  const t = getDict(await getLocale()).platform;
  const ctx = await getPlatformContext();
  const settings = await getSettings();

  const [counts, freshness, runs, inventory, alertCounts, exportCounts, deletionCounts, grantCounts, mrr, usage] =
    await Promise.all([
      tenantStatusCounts(),
      backupFreshness(),
      listBackupRuns(5),
      artifactInventory(),
      db
        .select({ severity: platformAlerts.severity, n: count() })
        .from(platformAlerts)
        .where(inArray(platformAlerts.status, ["open", "acknowledged"]))
        .groupBy(platformAlerts.severity),
      db.select({ status: tenantExports.status, n: count() }).from(tenantExports).groupBy(tenantExports.status),
      db
        .select({ status: deletionRequests.status, n: count() })
        .from(deletionRequests)
        .groupBy(deletionRequests.status),
      db
        .select({ n: count() })
        .from(supportGrants)
        .where(sql`${supportGrants.revokedAt} is null and ${supportGrants.expiresAt} > now()`),
      // MRR from the declared plan price of live subscriptions (never from tenant books)
      db.execute(sql`
        select coalesce(sum(p.price_monthly), 0)::text as mrr,
               count(*)::int as live
        from subscriptions s join plans p on p.code = s.plan_code
        where s.status in ('trial','active')`),
      db
        .select({ metric: usageMetrics.metric, total: sql<string>`sum(${usageMetrics.value})` })
        .from(usageMetrics)
        .groupBy(usageMetrics.metric),
    ]);

  const worker = getWorkerStatus();
  const openAlerts = alertCounts.reduce((sum, a) => sum + Number(a.n), 0);
  const criticalAlerts = Number(alertCounts.find((a) => a.severity === "critical")?.n ?? 0);
  const mrrRow = (mrr as unknown as { rows: { mrr: string; live: number }[] }).rows[0];
  const stale = freshness.stale;
  const badge = (s: string) => <Badge tone={statusTone(s)}>{s}</Badge>;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t.title}</h1>
          <p className="text-xs text-muted">{t.subtitle}</p>
        </div>
        <p className="text-[11px] text-muted">
          {actorLabelOf(ctx)} · <span className="font-mono">{ctx?.role}</span>
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t.backupFreshness}
          value={freshness.lastVerifiedAt ? `${freshness.ageHours?.toFixed(1)}h` : t.never}
          hint={
            freshness.lastVerifiedAt
              ? `${fmtDate(freshness.lastVerifiedAt)} · ${stale ? t.stale : t.fresh}`
              : t.never
          }
          tone={stale || !freshness.lastVerifiedAt ? "danger" : "success"}
        />
        <StatCard
          label={t.openAlerts}
          value={openAlerts}
          hint={`${criticalAlerts} ${t.critical}`}
          tone={criticalAlerts > 0 ? "danger" : openAlerts > 0 ? "warning" : "success"}
        />
        <StatCard
          label={t.mrrDeclared}
          value={new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(mrrRow?.mrr ?? 0))}
          hint={`${mrrRow?.live ?? 0} ${t.subscription}`}
        />
        <StatCard
          label={t.worker}
          value={(t.workerStates as Record<string, string>)[worker.status] ?? worker.status}
          hint={worker.startedAt ? fmtDate(worker.startedAt) : "pg-boss"}
          tone={worker.status === "ready" ? "success" : worker.status === "degraded" ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.tenantsByStatus}</h2>
          <div className="flex flex-wrap gap-3">
            {(["trial", "active", "suspended", "deactivated"] as const).map((s) => (
              <div key={s} className="rounded-xl border border-border px-4 py-3">
                <p className="text-xs text-muted">
                  {t[`status${s[0]!.toUpperCase()}${s.slice(1)}` as keyof typeof t] as string}
                </p>
                <p className="text-xl font-bold tnum">{counts[s] ?? 0}</p>
              </div>
            ))}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted">{t.inventory}</dt>
              <dd className="font-semibold tnum">
                {inventory.files.length} ·{" "}
                {fmtBytes(inventory.files.reduce((sum, f) => sum + f.bytes, 0))}
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t.piPolicy}</dt>
              <dd className="font-semibold tnum">
                {settings.backup.keepLatest}/{settings.backup.keepDaily}/{settings.backup.keepWeekly} ·{" "}
                {settings.backup.staleAfterHours}h
              </dd>
            </div>
          </dl>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.backupHistory}</h2>
          <table className="w-full text-xs">
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 tnum">{fmtDate(r.startedAt)}</td>
                  <td className="py-2">{badge(r.status)}</td>
                  <td className="py-2 font-mono text-[11px]">{r.kind}</td>
                  <td className="py-2 tnum">{fmtBytes(r.artifactBytes)}</td>
                  <td className="py-2">{r.drillStatus ? badge(r.drillStatus) : "—"}</td>
                </tr>
              ))}
              {runs.length === 0 ? (
                <tr>
                  <td className="py-3 text-muted">{t.never}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.usage}</h2>
          <ul className="space-y-1 text-xs">
            {usage.map((u) => (
              <li key={u.metric} className="flex justify-between border-b border-border/60 py-1 last:border-0">
                <span className="font-mono">{u.metric}</span>
                <span className="tnum font-semibold">{u.total}</span>
              </li>
            ))}
            {usage.length === 0 ? <li className="text-muted">{t.noUsage}</li> : null}
          </ul>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.dataLifecycle}</h2>
          <ul className="space-y-2 text-xs">
            <li className="flex justify-between">
              <span>{t.exportsTitle}</span>
              <span className="tnum">
                {exportCounts.map((e) => `${e.status}: ${e.n}`).join(" · ") || "—"}
              </span>
            </li>
            <li className="flex justify-between">
              <span>{t.deletion}</span>
              <span className="tnum">
                {deletionCounts.map((d) => `${d.status}: ${d.n}`).join(" · ") || "—"}
              </span>
            </li>
            <li className="flex justify-between">
              <span>{t.grants}</span>
              <span className="tnum">{grantCounts[0]?.n ?? 0}</span>
            </li>
          </ul>
          <p className="mt-3 rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-[11px] text-muted">
            {t.guideBody}
          </p>
        </section>
      </div>
    </div>
  );
}
