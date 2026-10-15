/**
 * Alerts inbox (PLATFORM_ADMIN §1.4).
 *
 * Alerts are operational: backup stale/failed, drill failed, queue dead letters,
 * ZATCA submission failures **aggregated per tenant** — never invoice content or
 * amounts. Acknowledge keeps the number and the audit trail.
 */

import Link from "next/link";
import { db } from "@/db";
import { platformAlerts, tenants } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import { alertAcknowledgeAction } from "@/modules/platform/actions";
import { ActionForm, Badge, StatCard, Table } from "../../ui";
import { fmtDate, statusTone } from "../../format";

export const dynamic = "force-dynamic";

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const t = getDict(await getLocale()).platform;
  const ctx = requirePlatformPermission(await getPlatformContext(), "platform.alerts.view");
  const params = await searchParams;
  const status = ["open", "acknowledged", "resolved"].includes(params.status ?? "")
    ? (params.status as "open" | "acknowledged" | "resolved")
    : undefined;

  const rows = await db
    .select({
      id: platformAlerts.id,
      severity: platformAlerts.severity,
      kind: platformAlerts.kind,
      title: platformAlerts.title,
      body: platformAlerts.body,
      status: platformAlerts.status,
      occurrences: platformAlerts.occurrences,
      firstSeenAt: platformAlerts.firstSeenAt,
      lastSeenAt: platformAlerts.lastSeenAt,
      tenantId: platformAlerts.tenantId,
      tenantName: tenants.name,
    })
    .from(platformAlerts)
    .leftJoin(tenants, eq(tenants.id, platformAlerts.tenantId))
    .where(status ? eq(platformAlerts.status, status) : sql`${platformAlerts.status} <> 'resolved'`)
    .orderBy(sql`case ${platformAlerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`, sql`${platformAlerts.lastSeenAt} desc`)
    .limit(200);

  const counts = await db
    .select({ severity: platformAlerts.severity, n: sql<number>`count(*)::int` })
    .from(platformAlerts)
    .where(eq(platformAlerts.status, "open"))
    .groupBy(platformAlerts.severity);
  const severityCount = (s: string) => Number(counts.find((c) => c.severity === s)?.n ?? 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">{t.alertsTitle}</h1>
        <p className="text-xs text-muted">{t.alertsHint}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t.critical} value={severityCount("critical")} tone={severityCount("critical") ? "danger" : "default"} />
        <StatCard label={t.warning} value={severityCount("warning")} tone={severityCount("warning") ? "warning" : "default"} />
        <StatCard label={t.info} value={severityCount("info")} />
      </div>

      <div className="flex gap-2 text-xs">
        {[
          { v: "", l: t.openOnly },
          { v: "open", l: t.statusOpen },
          { v: "acknowledged", l: t.statusAck },
          { v: "resolved", l: t.statusResolved },
        ].map((f) => (
          <Link
            key={f.v}
            href={f.v ? `/platform/alerts?status=${f.v}` : "/platform/alerts"}
            className={`rounded-xl border border-border px-3 py-1 ${status === f.v || (!f.v && !status) ? "bg-surface-2 font-bold" : ""}`}
          >
            {f.l}
          </Link>
        ))}
      </div>

      <Table head={[t.severity, t.kind, t.title, t.tenant, t.occurrences, t.lastSeen, t.actions]}>
        {rows.map((a) => (
          <tr key={a.id} className="border-t border-border/60">
            <td className="px-3 py-2">
              <Badge tone={statusTone(a.severity)}>{a.severity}</Badge>
            </td>
            <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
              {a.kind}
            </td>
            <td className="px-3 py-2">
              <p className="font-semibold">{a.title}</p>
              {a.body ? <p className="text-[11px] text-muted" dir="auto">{a.body.slice(0, 220)}</p> : null}
            </td>
            <td className="px-3 py-2 text-xs">
              {a.tenantId ? (
                <Link href={`/platform/tenants/${a.tenantId}`} className="underline">
                  {a.tenantName ?? a.tenantId.slice(0, 8)}
                </Link>
              ) : (
                "—"
              )}
            </td>
            <td className="px-3 py-2 tnum">{a.occurrences}</td>
            <td className="px-3 py-2 text-xs tnum">{fmtDate(a.lastSeenAt)}</td>
            <td className="px-3 py-2">
              {a.status === "open" && ctx.permissions.has("platform.alerts.manage") ? (
                <ActionForm action={alertAcknowledgeAction} hidden={{ alertId: a.id }} submitLabel={t.acknowledge} />
              ) : (
                <Badge tone={statusTone(a.status)}>{a.status}</Badge>
              )}
            </td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td className="px-3 py-4 text-muted" colSpan={7}>
              {t.noAlerts}
            </td>
          </tr>
        ) : null}
      </Table>
    </div>
  );
}
