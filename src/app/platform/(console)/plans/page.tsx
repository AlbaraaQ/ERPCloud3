/**
 * Plans & subscriptions (PLATFORM_ADMIN §1.3).
 *
 * Plans are declared data: price, currency and entitlements (features + quotas).
 * MRR shown here is computed from these declarations, never from tenant books.
 */

import { db } from "@/db";
import { plans as plansTable, subscriptions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import { KNOWN_FEATURES, subscriptionsDue } from "@/modules/platform/plans";
import { listTenants } from "@/modules/platform/tenants";
import { Badge, Table } from "../../ui";
import { fmtDate } from "../../format";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const t = getDict(await getLocale()).platform;
  requirePlatformPermission(await getPlatformContext(), "platform.plans.view");

  const [planRows, subs, due, tenants] = await Promise.all([
    db.select().from(plansTable).orderBy(plansTable.sortOrder),
    db
      .select({
        plan: subscriptions.planCode,
        status: subscriptions.status,
        n: sql<number>`count(*)::int`,
      })
      .from(subscriptions)
      .groupBy(subscriptions.planCode, subscriptions.status),
    subscriptionsDue(30),
    listTenants(),
  ]);

  const nameOf = (id: string) => tenants.find((x) => x.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">{t.plansTitle}</h1>
        <p className="text-xs text-muted">{t.subtitle}</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {planRows.map((p) => {
          const dist = subs.filter((s) => s.plan === p.code);
          return (
            <section key={p.code} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-bold">{p.name}</h2>
                  <p className="text-[11px] text-muted" dir="ltr">
                    {p.code} · {p.nameEn ?? ""}
                  </p>
                </div>
                <Badge tone={p.isActive ? "success" : "muted"}>{p.isActive ? t.activePlan : t.inactivePlan}</Badge>
              </div>
              <p className="mt-3 text-2xl font-bold tnum" dir="ltr">
                {p.priceMonthly} <span className="text-xs font-normal">{p.currency}</span>
                <span className="text-[11px] font-normal text-muted"> / {t.perMonth}</span>
              </p>

              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                {(["users", "branches", "warehouses", "invoicesPerMonth"] as const).map((k) => (
                  <div key={k}>
                    <dt className="text-muted">{t[`quota${k[0]!.toUpperCase()}${k.slice(1)}` as keyof typeof t] as string}</dt>
                    <dd className="tnum font-semibold">{(p.entitlements.quotas ?? {})[k] ?? t.unlimited}</dd>
                  </div>
                ))}
              </dl>

              <ul className="mt-3 flex flex-wrap gap-1">
                {(p.entitlements.features ?? []).map((f) => (
                  <li key={f} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10px]" dir="ltr">
                    {f}
                  </li>
                ))}
              </ul>

              <p className="mt-3 text-[11px] text-muted">
                {dist.map((d) => `${d.status}: ${d.n}`).join(" · ") || t.noSubscribers} · {t.assignToTenant}
              </p>
            </section>
          );
        })}
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-bold">{t.featureCatalog}</h2>
        <ul className="flex flex-wrap gap-2 text-[11px]">
          {KNOWN_FEATURES.map((f) => (
            <li key={f} className="rounded-md border border-border bg-surface-2/50 px-2 py-1 font-mono" dir="ltr">
              {f}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold">{t.upcomingRenewals}</h2>
        <Table head={[t.tenants, t.plan, t.statusLabel, t.renewsAt]}>
          {due.map((row) => (
            <tr key={row.tenantId} className="border-t border-border/60">
              <td className="px-3 py-2 text-sm">{nameOf(row.tenantId)}</td>
              <td className="px-3 py-2 font-mono text-xs">{row.planCode}</td>
              <td className="px-3 py-2">
                <Badge tone={row.status === "trialing" ? "info" : "success"}>{row.status}</Badge>
              </td>
              <td className="px-3 py-2 text-xs tnum">{fmtDate(row.renewsAt ?? row.trialEndsAt)}</td>
            </tr>
          ))}
          {due.length === 0 ? (
            <tr>
              <td className="px-3 py-3 text-muted" colSpan={4}>
                {t.noRenewals}
              </td>
            </tr>
          ) : null}
        </Table>
      </section>
    </div>
  );
}
