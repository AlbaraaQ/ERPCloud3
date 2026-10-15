import { eq, count } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant } from "@/modules/shared/db-context";
import { companies, branches, users, roles, auditLog } from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
import { hasPermission } from "@/modules/shared/context";
import Link from "next/link";
import { balancesByType } from "@/modules/reports/ledger";
import { arAging } from "@/modules/reports/receivables";
import { stockValuation } from "@/modules/reports/inventory";
import { runReconciliations } from "@/modules/reports/reconcile";
import { AlertTriangle, CheckCircle2, TrendingUp, TrendingDown, Wallet, Boxes } from "lucide-react";
import { todayBusinessDate } from "@/modules/shared/dates";
import {
  Users,
  GitBranch,
  KeyRound,
  ScrollText,
  Building2,
  BadgeCheck,
  Coins,
  Globe2,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "لوحة التحكم" };

export default async function DashboardPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");

  const locale = await getLocale();
  const t = getDict(locale);

  const canSeeMoney = hasPermission(ctx, "reports.financial.view");
  const canSeeReports = hasPermission(ctx, "reports.view");

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const [company] = await trx
      .select()
      .from(companies)
      .where(eq(companies.tenantId, ctx.tenant!.id))
      .limit(1);
    // serial: one pooled client cannot run concurrent queries (pg deprecation)
    const [u] = await trx.select({ n: count() }).from(users);
    const [b] = await trx.select({ n: count() }).from(branches);
    const [r] = await trx.select({ n: count() }).from(roles);
    const [a] = await trx.select({ n: count() }).from(auditLog);
    // Role-aware financial snapshot — the SAME report services as /reports, so the
    // dashboard can never disagree with the report it links to.
    const today = todayBusinessDate(company?.timezone);
    const month = { from: `${today.slice(0, 7)}-01`, to: today };
    let snapshot: {
      revenue: number;
      expense: number;
      net: number;
      receivables: number;
      inventoryValue: number;
      breaches: number;
    } | null = null;
    let breaches: number | null = null;
    if (canSeeReports) {
      const integrity = await runReconciliations(trx, ctx.tenant!.id, { from: month.from, to: month.to }, today);
      breaches = integrity.breaches;
    }
    if (canSeeMoney) {
      // one pooled client cannot run these concurrently (pg deprecation) — keep them serial
      const types = await balancesByType(trx, ctx.tenant!.id, month);
      const ar = await arAging(trx, ctx.tenant!.id, { asOf: today });
      const valuation = await stockValuation(trx, ctx.tenant!.id, {});
      snapshot = {
        revenue: types.revenue ?? 0,
        expense: types.expense ?? 0,
        net: Math.round(((types.revenue ?? 0) - (types.expense ?? 0)) * 100) / 100,
        receivables: ar.totalOutstanding,
        inventoryValue: valuation.totalValue,
        breaches: breaches ?? 0,
      };
    }
    return { company, users: u.n, branches: b.n, roles: r.n, audit: a.n, today, snapshot, breaches };
  });

  const stats = [
    { icon: Users, label: t.dashboard.users, value: data.users, tone: "text-info bg-info-soft" },
    { icon: GitBranch, label: t.dashboard.branches, value: data.branches, tone: "text-success bg-success-soft" },
    { icon: KeyRound, label: t.dashboard.roles, value: data.roles, tone: "text-warning bg-warning-soft" },
    { icon: ScrollText, label: t.dashboard.auditEvents, value: data.audit, tone: "text-primary bg-primary-soft" },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            {t.dashboard.welcome}، {ctx.userName}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.dashboard.title}</h1>
        </div>
        <p className="tnum rounded-xl bg-surface-2 px-4 py-2 text-sm font-medium text-muted">
          {t.dashboard.today}: <span className="font-semibold text-foreground">{todayBusinessDate(data.company?.timezone)}</span>
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="card flex items-center gap-4 p-5">
            <span className={`grid h-11 w-11 place-items-center rounded-xl ${s.tone}`}>
              <s.icon className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="tnum text-2xl font-bold">{s.value}</p>
              <p className="text-xs text-muted">{s.label}</p>
            </div>
          </div>
        ))}
      </section>

      {canSeeReports && (
        <section className="card p-4" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 font-medium">
              {data.breaches && data.breaches > 0 ? (
                <AlertTriangle className="h-5 w-5 text-red-600" aria-hidden />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
              )}
              {data.breaches && data.breaches > 0 ? t.reports.integrityBreach : t.reports.integrityOk}
            </p>
            <Link className="text-sm underline" href="/reports">
              {t.reports.title}
            </Link>
          </div>
        </section>
      )}

      {canSeeMoney && data.snapshot && (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { icon: TrendingUp, label: t.reports.kpiRevenue, value: data.snapshot.revenue },
            { icon: TrendingDown, label: t.reports.kpiExpense, value: data.snapshot.expense },
            { icon: Wallet, label: t.reports.kpiNet, value: data.snapshot.net },
            { icon: Boxes, label: t.reports.kpiInventory, value: data.snapshot.inventoryValue },
          ].map((kpi) => (
            <div key={kpi.label} className="card flex items-center gap-4 p-5">
              <span className="grid h-11 w-11 place-items-center rounded-xl text-primary bg-primary-soft">
                <kpi.icon className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <p className="tnum text-2xl font-bold">
                  {kpi.value.toLocaleString(locale === "ar" ? "ar-SA-u-nu-latn" : "en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
                <p className="text-xs text-muted">{kpi.label}</p>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted sm:col-span-2 xl:col-span-4">
            {t.reports.kpiHint} · {t.reports.kpiReceivables}:{" "}
            <span className="tnum">
              {data.snapshot.receivables.toLocaleString(locale === "ar" ? "ar-SA-u-nu-latn" : "en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </p>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-6">
          <div className="mb-4 flex items-center gap-2.5">
            <Building2 className="h-5 w-5 text-primary" aria-hidden />
            <h2 className="font-semibold">{t.dashboard.companyInfo}</h2>
          </div>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="flex items-center gap-2 text-muted">
                <BadgeCheck className="h-4 w-4" aria-hidden /> {t.dashboard.legalName}
              </dt>
              <dd className="font-medium">{data.company?.legalName ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
              <dt className="flex items-center gap-2 text-muted">
                <ScrollText className="h-4 w-4" aria-hidden /> {t.dashboard.vatNumber}
              </dt>
              <dd className="tnum font-medium" dir="ltr">{data.company?.vatNumber ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
              <dt className="flex items-center gap-2 text-muted">
                <Coins className="h-4 w-4" aria-hidden /> {t.dashboard.currency}
              </dt>
              <dd className="font-medium">{data.company?.baseCurrency ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
              <dt className="flex items-center gap-2 text-muted">
                <Globe2 className="h-4 w-4" aria-hidden /> {t.dashboard.timezone}
              </dt>
              <dd className="font-medium" dir="ltr">{data.company?.timezone ?? "—"}</dd>
            </div>
          </dl>
        </div>

        <div className="card border-primary/30 bg-primary-soft/40 p-6">
          <h2 className="font-semibold text-primary">حالة التنفيذ</h2>
          <p className="mt-3 text-sm leading-relaxed text-foreground/85">{t.dashboard.foundationNote}</p>
          <p className="mt-4 text-sm font-semibold text-foreground">
            {ctx.tenant.name} —{" "}
            <span className="text-success">
              {ctx.tenant.status === "trial" ? t.dashboard.statusTrial : t.dashboard.statusActive}
            </span>
          </p>
        </div>
      </section>
    </div>
  );
}
