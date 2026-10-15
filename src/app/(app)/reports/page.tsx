import { redirect } from "next/navigation";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { AlertTriangle, CheckCircle2, Download, FileBarChart2 } from "lucide-react";
import { getSessionContext } from "@/modules/identity/auth";
import { hasPermission, requirePermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import { getLocale, getDict } from "@/i18n";
import { todayBusinessDate } from "@/modules/shared/dates";
import { accounts as accountsTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { REPORT_CATALOG, catalogByGroup, integrityAudit, integrityPack, runReport, type ReportParams, type ReportResult } from "@/modules/reports";

export const dynamic = "force-dynamic";
export const metadata = { title: "التقارير" };

/** Financial statements need the stricter permission (spec §5: permitted viewers only). */
const FINANCIAL = new Set(["R-03", "R-04", "R-05", "R-12", "R-13"]);
/** drill-down targets → the permission that unlocks the link */
const DRILL_PERM: Record<string, string> = {
  "R-01": "reports.financial.view",
  "R-26": "reports.view",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

/** Default range: the first day this tenant posted anything (falls back to month start). */
async function defaultFrom(trx: Parameters<Parameters<typeof withTenant>[1]>[0], tenantId: string, today: string): Promise<string> {
  const rows = (await trx.execute(
    sql`select min(business_date) as first_day from journal_entries where tenant_id = ${tenantId} and status = 'posted'`,
  )) as unknown as { rows: { first_day: string | null }[] };
  return rows.rows[0]?.first_day ?? monthStart(today);
}

export default async function ReportsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "reports.view");

  const sp = await searchParams;
  const locale = await getLocale();
  const t = getDict(locale);
  const rep = t.rep as unknown as Record<string, string>;
  const page = t.reports as unknown as Record<string, string>;
  const today = todayBusinessDate();

  const codeParam = one(sp.report) ?? "R-02";
  const requestedFrom = one(sp.from);
  const params: ReportParams = {
    from: requestedFrom,
    to: one(sp.to) ?? today,
    asOf: one(sp.asOf) ?? today,
    dim: one(sp.dim),
    accountId: one(sp.accountId),
    warehouseId: one(sp.warehouseId),
    partyId: one(sp.partyId),
    slowDays: one(sp.slowDays),
    includeZero: one(sp.includeZero),
  };
  const definition = REPORT_CATALOG.find((d) => d.code === codeParam) ?? REPORT_CATALOG[1];
  const wantsFinancial = FINANCIAL.has(definition.code);
  const allowedFinancial = hasPermission(ctx, "reports.financial.view");
  const canExport = hasPermission(ctx, "reports.export");

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    params.from = requestedFrom ?? (await defaultFrom(trx, ctx.tenant!.id, today));
    const integrity = await integrityPack(trx, ctx.tenant!.id, { from: params.from, to: params.to }, today);
    const audit = await integrityAudit(trx, ctx.tenant!.id);
    const accts = await trx
      .select({ id: accountsTable.id, code: accountsTable.code, nameAr: accountsTable.nameAr })
      .from(accountsTable)
      .where(eq(accountsTable.tenantId, ctx.tenant!.id))
      .orderBy(accountsTable.code);
    const warehouses = (await trx.execute(
      sql`select id, name from warehouses where tenant_id = ${ctx.tenant!.id} order by name`,
    )) as unknown as { rows: { id: string; name: string }[] };
    let result: ReportResult | null = null;
    let failure: string | null = null;
    if (!wantsFinancial || allowedFinancial) {
      try {
        result = await runReport(trx, ctx.tenant!.id, definition.code, params);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    return { integrity, audit, accts, warehouses: warehouses.rows, result, failure };
  });

  const groups: { key: string; label: string; items: typeof REPORT_CATALOG }[] = [
    { key: "accounting", label: page.groupAccounting, items: catalogByGroup().accounting ?? [] },
    { key: "sales", label: page.groupSales, items: catalogByGroup().sales ?? [] },
    { key: "inventory", label: page.groupInventory, items: catalogByGroup().inventory ?? [] },
    { key: "tax", label: page.groupTax, items: catalogByGroup().tax ?? [] },
  ];
  const breaches = data.integrity.filter((r) => !r.ok);
  const result = data.result;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <FileBarChart2 className="h-5 w-5" aria-hidden />
          {page.title}
        </h1>
        <div className="text-sm text-muted">
          {page.asOf} {today} · {ctx.tenant.name}
        </div>
      </header>

      {/* RL-1…RL-5 — a breach is never masked (spec §5) */}
      <section
        className={`card border-2 p-3 ${breaches.length ? "border-red-400 bg-red-50/60 dark:bg-red-950/30" : "border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20"}`}
        aria-live="polite"
      >
        <div className="flex items-center gap-2 font-medium">
          {breaches.length ? (
            <AlertTriangle className="h-5 w-5 text-red-600" aria-hidden />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
          )}
          {breaches.length ? page.integrityBreach : page.integrityOk}
        </div>
        <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {data.integrity.map((r, i) => (
            <li key={`${r.code}-${r.titleKey}-${i}`} className="flex items-center justify-between gap-2 rounded px-2 py-1 tabular-nums">
              <span>
                <bdi>{r.code}</bdi> · {rep[r.titleKey.split(".").slice(1).join(".")] ?? r.titleKey}
                {r.note ? <span className="text-muted"> · {r.note}</span> : null}
              </span>
              <span className={r.ok ? "text-emerald-700" : "font-semibold text-red-600"}>
                {r.ok ? "0.00" : `${r.left} ≠ ${r.right}`}
              </span>
            </li>
          ))}
        </ul>
        {(data.audit.missing.length > 0 || data.audit.dangling.length > 0) && (
          <div className="mt-2 text-sm text-red-700">
            {data.audit.missing.length > 0 && (
              <p>
                {page.postingsMissing}: {data.audit.missing.length}
              </p>
            )}
            {data.audit.dangling.length > 0 && (
              <p>
                {page.danglingReversals}: {data.audit.dangling.length}
              </p>
            )}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <nav className="card space-y-3 p-3 text-sm">
          {groups.map((group) => (
            <div key={group.key}>
              <p className="mb-1 font-medium text-muted">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.code}>
                    <Link
                      href={`/reports?report=${item.code}`}
                      className={`flex items-baseline justify-between gap-2 rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5 ${
                        item.code === definition.code ? "bg-black/5 font-medium dark:bg-white/10" : ""
                      } ${item.status === "pending" ? "opacity-60" : ""}`}
                    >
                      <span>{rep[item.titleKey.split(".").slice(1).join(".")] ?? item.titleKey}</span>
                      <span className="text-xs text-muted" dir="ltr">
                        {item.code}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <section className="space-y-3">
          <form className="card flex flex-wrap items-end gap-3 p-3 text-sm" method="get">
            <input type="hidden" name="report" value={definition.code} />
            <label className="flex flex-col gap-1">
              <span className="text-muted">{page.from}</span>
              <input type="date" name="from" defaultValue={params.from} className="input" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">{page.to}</span>
              <input type="date" name="to" defaultValue={params.to} className="input" />
            </label>
            {definition.needs.includes("asOf") && (
              <label className="flex flex-col gap-1">
                <span className="text-muted">{page.asOf}</span>
                <input type="date" name="asOf" defaultValue={params.asOf} className="input" />
              </label>
            )}
            {definition.dims && (
              <label className="flex flex-col gap-1">
                <span className="text-muted">{page.dimension}</span>
                <select name="dim" defaultValue={params.dim ?? definition.dims[0].key} className="input">
                  {definition.dims.map((d) => (
                    <option key={d.key} value={d.key}>
                      {rep[d.titleKey.split(".").slice(1).join(".")] ?? d.titleKey}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(definition.code === "R-01" || definition.code === "R-07") && (
              <label className="flex flex-col gap-1">
                <span className="text-muted">{page.account}</span>
                <select name="accountId" defaultValue={params.accountId ?? ""} className="input">
                  <option value="">—</option>
                  {data.accts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.nameAr}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {["R-40", "R-41"].includes(definition.code) && (
              <label className="flex flex-col gap-1">
                <span className="text-muted">{page.warehouse}</span>
                <select name="warehouseId" defaultValue={params.warehouseId ?? ""} className="input">
                  <option value="">—</option>
                  {data.warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {definition.code === "R-43" && (
              <label className="flex flex-col gap-1">
                <span className="text-muted">{page.slowDays}</span>
                <input type="number" min={1} name="slowDays" defaultValue={params.slowDays ?? "90"} className="input" />
              </label>
            )}
            {definition.code === "R-02" && (
              <label className="flex items-center gap-2 pb-2">
                <input type="checkbox" name="includeZero" value="1" defaultChecked={params.includeZero === "1"} />
                <span>{page.includeZero}</span>
              </label>
            )}
            <button type="submit" className="btn">
              {page.apply}
            </button>
            {canExport && (
              <Link
                className="btn-ghost btn"
                href={`/reports/export?${new URLSearchParams({ ...(params as Record<string, string>), report: definition.code } as Record<string, string>).toString()}`}
              >
                <Download className="h-4 w-4" aria-hidden />
                {page.export}
              </Link>
            )}
          </form>

          <div className="card overflow-x-auto p-3">
            <h2 className="mb-2 font-medium">
              {rep[definition.titleKey.split(".").slice(1).join(".")] ?? definition.titleKey}
            </h2>

            {definition.status === "pending" ? (
              <p className="text-sm text-amber-700">{page.pending}: {definition.pendingReason}</p>
            ) : wantsFinancial && !allowedFinancial ? (
              <p className="text-sm text-amber-700">{page.needsFinancialPermission}</p>
            ) : data.failure ? (
              <p className="text-sm text-red-600">{data.failure}</p>
            ) : result && result.rows.length === 0 ? (
              <p className="text-sm text-muted">{page.empty}</p>
            ) : result ? (
              <table className="table w-full text-sm">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.key} className={c.kind === "money" || c.kind === "qty" ? "text-start" : "text-start"}>
                        {rep[c.titleKey.split(".").slice(1).join(".")] ?? c.titleKey}
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => {
                    const drillPerm = row.drill ? DRILL_PERM[row.drill.report] : undefined;
                    const canDrill = row.drill && drillPerm ? hasPermission(ctx, drillPerm) && (row.drill.report !== "R-01" || allowedFinancial) : false;
                    return (
                      <tr key={row.id}>
                        {row.cells.map((cell, i) => (
                          <td key={i} className={result.columns[i]?.kind === "money" || result.columns[i]?.kind === "qty" ? "tabular-nums" : ""}>
                            {cell === null || cell === "" ? <span className="text-muted">—</span> : typeof cell === "number" ? cell.toLocaleString(locale === "ar" ? "ar-SA-u-nu-latn" : "en-US", { minimumFractionDigits: result.columns[i]?.kind === "int" ? 0 : 2, maximumFractionDigits: result.columns[i]?.kind === "int" ? 0 : 2 }) : <bdi>{cell}</bdi>}
                          </td>
                        ))}
                        <td>
                          {canDrill && row.drill ? (
                            <Link
                              className="text-xs underline"
                              href={`/reports?${new URLSearchParams({ ...row.drill.params, report: row.drill.report }).toString()}`}
                            >
                              {page.drill}
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  {result.totals && (
                    <tr className="border-t-2 font-medium">
                      {result.totals.map((cell, i) => (
                        <td key={i} className="tabular-nums">
                          {typeof cell === "number"
                            ? cell.toLocaleString(locale === "ar" ? "ar-SA-u-nu-latn" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                            : cell === "" || cell === null
                              ? ""
                              : <bdi>{cell}</bdi>}
                        </td>
                      ))}
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            ) : null}

            {result && result.notes.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-muted">
                {result.notes.map((n, i) => (
                  <li key={i}>• {n}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
