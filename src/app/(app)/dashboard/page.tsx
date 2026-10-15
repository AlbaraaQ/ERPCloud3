import { eq, count } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant } from "@/modules/shared/db-context";
import { companies, branches, users, roles, auditLog } from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
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

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const [company] = await trx
      .select()
      .from(companies)
      .where(eq(companies.tenantId, ctx.tenant!.id))
      .limit(1);
    const [[u], [b], [r], [a]] = await Promise.all([
      trx.select({ n: count() }).from(users),
      trx.select({ n: count() }).from(branches),
      trx.select({ n: count() }).from(roles),
      trx.select({ n: count() }).from(auditLog),
    ]);
    return { company, users: u.n, branches: b.n, roles: r.n, audit: a.n };
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
