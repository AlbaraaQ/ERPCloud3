/**
 * Tenant detail (PLATFORM_ADMIN §1.2–§2).
 *
 * Shows identity, subscription lifecycle, quota usage (counts), flags and the
 * support-grant ledger. Everything here is metadata; reading tenant books needs
 * an approved grant and happens in the tenant's own screens (never impersonation).
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, deletionRequests, plans as plansTable } from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import { tenantOverview } from "@/modules/platform/tenants";
import { listGrants } from "@/modules/platform/grants";
import { listExports } from "@/modules/platform/exports";
import {
  deletionLegalHoldAction,
  deletionPurgeAction,
  deletionRequestAction,
  exportBuildAction,
  flagSetAction,
  grantApproveAction,
  grantRequestAction,
  grantRevokeAction,
  tenantPlanAction,
  tenantStatusAction,
} from "@/modules/platform/actions";
import { GRANTABLE_SCREENS } from "@/modules/platform/permissions";
import { ActionForm, Badge, Field, Table, fmtBytes, fmtDate, statusTone } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getDict(await getLocale()).platform;
  const ctx = requirePlatformPermission(await getPlatformContext(), "platform.tenants.view");

  const overview = await tenantOverview(id).catch(() => null);
  if (!overview) notFound();

  const [planRows, grants, exports, deletions, tenantAudit] = await Promise.all([
    db.select().from(plansTable).orderBy(plansTable.sortOrder),
    listGrants(id),
    listExports(id, 10),
    db.select().from(deletionRequests).where(eq(deletionRequests.tenantId, id)).orderBy(desc(deletionRequests.createdAt)),
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorLabel: auditLog.actorLabel,
        at: auditLog.at,
        entity: auditLog.entity,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, id), like(auditLog.action, "platform.%")))
      .orderBy(desc(auditLog.at))
      .limit(20),
  ]);

  const { tenant, company, subscription, counts, activity, quotas, flags } = overview;
  const pending = deletions.find((d) => d.status !== "purged" && d.status !== "cancelled");
  const statusLabel = (s: string) =>
    (t[`status${s[0]!.toUpperCase()}${s.slice(1)}` as keyof typeof t] as string) ?? s;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] text-muted">
            <Link href="/platform/tenants" className="underline">
              {t.tenants}
            </Link>
            {" / "}
            {tenant.name}
          </p>
          <h1 className="text-xl font-bold">{tenant.name}</h1>
          <p className="text-xs text-muted" dir="ltr">
            {tenant.nameEn ?? company?.legalName ?? ""} · {tenant.id.slice(0, 8)} · {fmtDate(tenant.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={statusTone(tenant.status)}>{statusLabel(tenant.status)}</Badge>
          <Badge tone="info">{tenant.plan}</Badge>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.overview}</h2>
          <dl className="space-y-1 text-xs">
            <Row label={t.legalName} value={company?.legalName ?? "—"} />
            <Row label={t.vatNumber} value={company?.vatNumber ?? "—"} ltr />
            <Row label={t.timezoneLabel} value={company?.timezone ?? "—"} ltr />
            <Row label={t.subscription} value={subscription ? `${subscription.planCode} · ${subscription.status}` : "—"} />
            <Row label={t.renews} value={fmtDate(subscription?.renewsAt ?? subscription?.trialEndsAt)} />
          </dl>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.activity}</h2>
          <dl className="space-y-1 text-xs">
            <Row label={t.postedJournals} value={String(activity.postedJournals)} />
            <Row label={t.stockMovements} value={String(activity.stockMovements)} />
            <Row label={t.users} value={String(counts.users)} />
            <Row label={t.branches} value={String(counts.branches)} />
            <Row label={t.products} value={String(counts.products)} />
            <Row label={t.customers} value={String(counts.customers)} />
            <Row label={t.lastPosting} value={fmtDate(activity.lastPosting)} />
          </dl>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.quotas}</h2>
          <ul className="space-y-2 text-xs">
            {quotas.map((q) => (
              <li key={q.metric}>
                <div className="flex justify-between">
                  <span>{(t as unknown as Record<string, string>)[`quota${q.metric[0]!.toUpperCase()}${q.metric.slice(1)}`] ?? q.metric}</span>
                  <span className="tnum">
                    {q.used} / {q.limit === null ? t.unlimited : q.limit}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={`h-full ${q.exceeded ? "bg-danger" : q.warning ? "bg-warning" : "bg-success"}`}
                    style={{ width: `${q.limit ? Math.min(100, (q.used / q.limit) * 100) : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-muted">{t.quotaHint}</p>
        </section>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <ActionForm
          action={tenantStatusAction}
          className="card p-4"
          submitLabel={t.save}
          render={() => <p className="mt-2 text-[11px] text-muted">{t.lifecycleHint}</p>}
        >
          <h2 className="mb-3 text-sm font-bold">{t.lifecycle}</h2>
          <input type="hidden" name="tenantId" value={id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.lifecycleTarget}>
              <select className="input" name="to" defaultValue="suspended">
                {(["trial", "active", "suspended", "deactivated"] as const)
                  .filter((s) => s !== tenant.status)
                  .map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t.reason} hint={t.reasonRequired}>
              <input className="input" name="reason" required />
            </Field>
          </div>
          <p className="mt-3 rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-[11px] text-muted">
            {t.lifecycleHint}
          </p>
        </ActionForm>

        <ActionForm action={tenantPlanAction} className="card p-4" submitLabel={t.save}>
          <h2 className="mb-3 text-sm font-bold">{t.planChange}</h2>
          <input type="hidden" name="tenantId" value={id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.plan}>
              <select className="input" name="planCode" defaultValue={subscription?.planCode ?? tenant.plan}>
                {planRows.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name} ({p.currency} {p.priceMonthly})
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.renewsAt}>
              <input className="input" name="renewsAt" type="date" dir="ltr" />
            </Field>
          </div>
        </ActionForm>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.flags}</h2>
          <ActionForm action={flagSetAction} submitLabel={t.set}>
            <input type="hidden" name="tenantId" value={id} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t.flagKey}>
                <input className="input" name="key" dir="ltr" required />
              </Field>
              <Field label={t.enabled}>
                <select className="input" name="enabled" defaultValue="true">
                  <option value="true">ON</option>
                  <option value="false">OFF</option>
                </select>
              </Field>
              <Field label={t.flagNote}>
                <input className="input" name="note" />
              </Field>
            </div>
          </ActionForm>
          <ul className="mt-4 space-y-1 text-xs">
            {Object.entries(flags).map(([k, v]) => (
              <li key={k} className="flex justify-between border-b border-border/60 py-1 last:border-0">
                <span className="font-mono" dir="ltr">
                  {k}
                </span>
                <Badge tone={v ? "success" : "muted"}>{v ? "ON" : "OFF"}</Badge>
              </li>
            ))}
            {Object.keys(flags).length === 0 ? <li className="text-muted">{t.noFlags}</li> : null}
          </ul>
        </div>

        <div className="card border-warning/40 p-4">
          <h2 className="mb-3 text-sm font-bold">{t.grants}</h2>
          <ActionForm action={grantRequestAction} submitLabel={t.requestGrant}>
            <input type="hidden" name="tenantId" value={id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.screens}>
                <select className="input" name="screens" multiple size={4}>
                  {GRANTABLE_SCREENS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="space-y-2">
                <Field label={t.hoursLabel}>
                  <input className="input tnum" name="hours" type="number" min={1} max={24} defaultValue={4} />
                </Field>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="amounts" /> {t.amounts}
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="exports" /> {t.exportsAllowed}
                </label>
              </div>
              <Field label={t.reason}>
                <input className="input" name="reason" required />
              </Field>
            </div>
          </ActionForm>

          <Table head={[t.statusLabel, t.screens, t.expiresAt, t.uses, t.actions]}>
            {grants.map((g) => (
              <tr key={g.id} className="border-t border-border/60">
                <td className="px-3 py-2">
                  <Badge
                    tone={
                      g.revokedAt ? "danger" : !g.platformApprovedByPlatformUserId ? "warning" : g.expiresAt < new Date() ? "muted" : "success"
                    }
                  >
                    {g.revokedAt ? t.grantRevoked : !g.platformApprovedByPlatformUserId ? t.grantPending : g.expiresAt < new Date() ? t.grantExpired : t.grantActive}
                  </Badge>
                </td>
                <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                  {(g.scope.screens ?? []).join(", ")}
                  {g.scope.amounts ? " · amounts" : ""}
                  {g.scope.exports ? " · exports" : ""}
                </td>
                <td className="px-3 py-2 text-xs">{fmtDate(g.expiresAt)}</td>
                <td className="px-3 py-2 tnum">{g.useCount}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    {!g.platformApprovedByPlatformUserId && !g.revokedAt ? (
                      <ActionForm action={grantApproveAction} hidden={{ grantId: g.id }} submitLabel={t.approve} />
                    ) : null}
                    {!g.revokedAt && ctx.permissions.has("platform.grants.revoke") ? (
                      <ActionForm
                        action={grantRevokeAction}
                        hidden={{ grantId: g.id, reason: t.revokedByOperator }}
                        submitLabel={t.revoke}
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {grants.length === 0 ? (
              <tr>
                <td className="px-3 py-3 text-muted" colSpan={5}>
                  {t.noGrants}
                </td>
              </tr>
            ) : null}
          </Table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.exportsTitle}</h2>
          <ActionForm action={exportBuildAction} hidden={{ tenantId: id }} submitLabel={t.buildExport} />
          <ul className="mt-3 space-y-1 text-xs">
            {exports.map((e) => (
              <li key={e.id} className="flex items-center justify-between border-b border-border/60 py-1 last:border-0">
                <span>
                  <Badge tone={statusTone(e.status)}>{e.status}</Badge>{" "}
                  <span className="tnum">{fmtBytes(e.bytes)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-[11px] text-muted">{fmtDate(e.createdAt)}</span>
                  {e.status === "ready" ? (
                    <a className="underline" href={`/api/platform/export/${e.id}`}>
                      {t.download}
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
            {exports.length === 0 ? <li className="text-muted">{t.noExports}</li> : null}
          </ul>
        </div>

        <div className="card border-danger/40 p-4">
          <h2 className="mb-3 text-sm font-bold">{t.deletion}</h2>
          {!pending ? (
            <ActionForm action={deletionRequestAction} hidden={{ tenantId: id }} submitLabel={t.requestDeletion} confirm={t.deletionConfirm}>
              <Field label={t.reason}>
                <input className="input" name="reason" required />
              </Field>
            </ActionForm>
          ) : (
            <div className="space-y-3 text-xs">
              <p>
                <Badge tone={statusTone(pending.status)}>{pending.status}</Badge>{" "}
                {t.coolingOffUntil}: <span className="tnum">{fmtDate(pending.coolingOffUntil)}</span>
              </p>
              <p className="text-muted">{pending.reason}</p>
              <ActionForm
                action={deletionLegalHoldAction}
                hidden={{ requestId: pending.id, hold: pending.legalHold ? "false" : "true" }}
                submitLabel={pending.legalHold ? t.clearHold : t.legalHold}
              />
              <ActionForm action={deletionPurgeAction} hidden={{ requestId: pending.id }} submitLabel={t.purge}>
                <Field label={t.purgeHint}>
                  <input className="input" name="confirmation" placeholder={tenant.name} required />
                </Field>
              </ActionForm>
            </div>
          )}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-bold">{t.tenantAuditTitle}</h2>
        <Table head={[t.at, t.actor, t.action, t.entity]}>
          {tenantAudit.map((row) => (
            <tr key={row.id} className="border-t border-border/60">
              <td className="px-3 py-2 text-xs tnum">{fmtDate(row.at)}</td>
              <td className="px-3 py-2 text-xs">{row.actorLabel}</td>
              <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                {row.action}
              </td>
              <td className="px-3 py-2 text-xs">{row.entity ?? "—"}</td>
            </tr>
          ))}
          {tenantAudit.length === 0 ? (
            <tr>
              <td className="px-3 py-3 text-muted" colSpan={4}>
                {t.noAudit}
              </td>
            </tr>
          ) : null}
        </Table>
      </section>
    </div>
  );
}

function Row({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold" dir={ltr ? "ltr" : undefined}>
        {value}
      </dd>
    </div>
  );
}
