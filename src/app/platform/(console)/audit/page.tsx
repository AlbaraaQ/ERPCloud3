/**
 * Platform audit log (PLATFORM_ADMIN §3, AC-031).
 *
 * Append-only, hash-chained: every row carries the hash of its predecessor, so
 * tampering is detectable. This page renders the chain and its own verification
 * result — a broken link is shown, not hidden.
 */

import { db } from "@/db";
import { platformAuditLog } from "@/db/schema";
import { desc, sql } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import { verifyAuditChain } from "@/modules/platform/audit";
import { Badge, StatCard, Table, fmtDate } from "../../ui";

export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const t = getDict(await getLocale()).platform;
  requirePlatformPermission(await getPlatformContext(), "platform.audit.view");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = 100;

  const [rows, total, chain] = await Promise.all([
    db
      .select()
      .from(platformAuditLog)
      .where(params.q ? sql`${platformAuditLog.action} ilike ${"%" + params.q + "%"} or ${platformAuditLog.actorLabel} ilike ${"%" + params.q + "%"}` : sql`true`)
      .orderBy(desc(platformAuditLog.at))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(platformAuditLog),
    verifyAuditChain(5000),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">{t.auditTitle}</h1>
        <p className="text-xs text-muted">{t.auditHint}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t.auditEntries} value={total[0]?.n ?? 0} />
        <StatCard
          label={t.chainStatus}
          value={chain.ok ? t.chainOk : t.chainBroken}
          hint={chain.brokenAt ? `${t.at} ${fmtDate(chain.brokenAt)}` : `${chain.checked} ${t.checked}`}
          tone={chain.ok ? "success" : "danger"}
        />
        <StatCard label={t.pageLabel} value={page} hint={`/ ${Math.max(1, Math.ceil((total[0]?.n ?? 0) / pageSize))}`} />
      </div>

      <form className="card flex items-end gap-3 p-4" method="get">
        <label className="min-w-[14rem] flex-1">
          <span className="mb-1 block text-xs font-semibold text-muted">{t.search}</span>
          <input className="input" name="q" defaultValue={params.q ?? ""} dir="ltr" />
        </label>
        <button className="btn btn-primary" type="submit">
          {t.filter}
        </button>
      </form>

      <Table head={[t.at, t.actor, t.action, t.entity, t.hashLabel]}>
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-border/60">
            <td className="px-3 py-2 text-xs tnum">{fmtDate(r.at)}</td>
            <td className="px-3 py-2 text-xs">{r.actorLabel}</td>
            <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
              {r.action}
            </td>
            <td className="px-3 py-2 text-xs">
              {r.entity ?? "—"}
              {r.entityId ? <span className="text-[10px] text-muted"> {r.entityId.slice(0, 8)}</span> : null}
            </td>
            <td className="px-3 py-2 font-mono text-[10px] text-muted" dir="ltr">
              {r.hash.slice(0, 12)}…{r.prevHash ? r.prevHash.slice(0, 6) : "genesis"}
            </td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td className="px-3 py-4 text-muted" colSpan={5}>
              {t.noAudit}
            </td>
          </tr>
        ) : null}
      </Table>

      <div className="flex justify-between text-xs">
        {page > 1 ? (
          <a className="underline" href={`/platform/audit?page=${page - 1}${params.q ? `&q=${params.q}` : ""}`}>
            {t.prevPage}
          </a>
        ) : (
          <span />
        )}
        {(total[0]?.n ?? 0) > page * pageSize ? (
          <a className="underline" href={`/platform/audit?page=${page + 1}${params.q ? `&q=${params.q}` : ""}`}>
            {t.nextPage}
          </a>
        ) : (
          <span />
        )}
      </div>

      {!chain.ok ? (
        <p className="card border-danger/40 p-4 text-xs text-danger">
          <Badge tone="danger">{t.chainBroken}</Badge> {chain.detail}
        </p>
      ) : null}
    </div>
  );
}
