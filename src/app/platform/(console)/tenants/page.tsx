/**
 * Tenant list + provisioning (PLATFORM_ADMIN §1.2).
 *
 * Columns are identity, plan, status, counts and last-posting **timestamp** —
 * never an amount. Lifecycle changes keep history: suspension and deactivation
 * mark status, they do not delete rows (AC-030).
 */

import Link from "next/link";
import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import { listTenants } from "@/modules/platform/tenants";
import { listPlans } from "@/modules/platform/plans";
import { getSettings } from "@/modules/platform/settings";
import { tenantCreateAction } from "@/modules/platform/actions";
import { ActionForm, Badge, Field, Table, fmtDate, statusTone } from "../../ui";

export const dynamic = "force-dynamic";

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const t = getDict(await getLocale()).platform;
  const ctx = requirePlatformPermission(await getPlatformContext(), "platform.tenants.view");
  const params = await searchParams;
  const status = ["trial", "active", "suspended", "deactivated"].includes(params.status ?? "")
    ? (params.status as "trial" | "active" | "suspended" | "deactivated")
    : undefined;

  const [rows, plans] = await Promise.all([listTenants({ q: params.q, status }), listPlans()]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">{t.tenants}</h1>
        <p className="text-xs text-muted">{t.subtitle}</p>
      </header>

      <form className="card flex flex-wrap items-end gap-3 p-4" method="get">
        <Field label={t.searchTenant}>
          <input className="input" name="q" defaultValue={params.q ?? ""} />
        </Field>
        <Field label={t.statusLabel}>
          <select className="input" name="status" defaultValue={params.status ?? ""}>
            <option value="">{t.all}</option>
            {(["trial", "active", "suspended", "deactivated"] as const).map((s) => (
              <option key={s} value={s}>
                {t[`status${s[0]!.toUpperCase()}${s.slice(1)}` as keyof typeof t] as string}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn btn-primary" type="submit">
          {t.filter}
        </button>
      </form>

      <Table
        head={[t.tenants, t.plan, t.statusLabel, t.users, t.lastPosting, t.actions]}
      >
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-border/60">
            <td className="px-3 py-2">
              <Link href={`/platform/tenants/${r.id}`} className="font-semibold hover:underline">
                {r.name}
              </Link>
              {r.nameEn ? <p className="text-[11px] text-muted" dir="ltr">{r.nameEn}</p> : null}
            </td>
            <td className="px-3 py-2 font-mono text-xs">{r.plan}</td>
            <td className="px-3 py-2">
              <Badge tone={statusTone(r.status)}>
                {t[`status${r.status[0]!.toUpperCase()}${r.status.slice(1)}` as keyof typeof t] as string}
              </Badge>
            </td>
            <td className="px-3 py-2 tnum">{r.users}</td>
            <td className="px-3 py-2 text-xs">{fmtDate(r.lastPostingAt)}</td>
            <td className="px-3 py-2">
              <Link href={`/platform/tenants/${r.id}`} className="text-xs underline">
                {t.open}
              </Link>
            </td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td className="px-3 py-4 text-muted" colSpan={6}>
              {t.noTenants}
            </td>
          </tr>
        ) : null}
      </Table>

      {ctx.permissions.has("platform.tenants.manage") ? (
        <ActionForm
          action={tenantCreateAction as never}
          className="card max-w-3xl p-4"
          submitLabel={t.create}
        >
          <h2 className="mb-3 text-sm font-bold">{t.createTenant}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.nameAr}>
              <input className="input" name="name" required />
            </Field>
            <Field label={t.nameEn}>
              <input className="input" name="nameEn" dir="ltr" />
            </Field>
            <Field label={t.legalName}>
              <input className="input" name="legalName" required />
            </Field>
            <Field label={t.vatNumber}>
              <input className="input" name="vatNumber" dir="ltr" placeholder="300000000000003" />
            </Field>
            <Field label={t.plan}>
              <select className="input" name="planCode" defaultValue={(await getSettings()).defaultPlanCode}>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.trialDays}>
              <input className="input tnum" name="trialDays" type="number" min={0} max={90} defaultValue={14} />
            </Field>
            <Field label={t.ownerName}>
              <input className="input" name="ownerName" required />
            </Field>
            <Field label={t.ownerEmail}>
              <input className="input" name="ownerEmail" type="email" dir="ltr" required />
            </Field>
            <Field label={t.ownerPassword} hint={t.passwordHint}>
              <input className="input" name="ownerPassword" type="password" required minLength={12} />
            </Field>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}
