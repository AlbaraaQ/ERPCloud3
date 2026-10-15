/**
 * CSV export for any report (spec §0: export events are audited).
 *
 * The export runs the SAME dispatcher as the screen, so a downloaded file can never
 * disagree with what the viewer saw. Drill-down data is not included — only the rows
 * of the report itself — and the export is refused without `reports.export`.
 */

import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { hasPermission, requirePermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import { writeAudit } from "@/modules/shared/audit";
import { getLocale, getDict } from "@/i18n";
import { todayBusinessDate } from "@/modules/shared/dates";
import { sql } from "drizzle-orm";
import { REPORT_CATALOG, runReport, type ReportParams, type ReportResult } from "@/modules/reports";

export const dynamic = "force-dynamic";

const FINANCIAL = new Set(["R-03", "R-04", "R-05", "R-12", "R-13"]);

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(result: ReportResult, titles: string[]): string {
  const lines = [titles.map(csvCell).join(",")];
  for (const row of result.rows) lines.push(row.cells.map(csvCell).join(","));
  if (result.totals) lines.push(result.totals.map(csvCell).join(","));
  // Excel needs the BOM to read Arabic correctly
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export async function GET(request: Request): Promise<Response> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "reports.export");

  const url = new URL(request.url);
  const today = todayBusinessDate();
  const requestedFrom = url.searchParams.get("from");
  const params: ReportParams = {
    from: requestedFrom ?? undefined,
    to: url.searchParams.get("to") ?? today,
    asOf: url.searchParams.get("asOf") ?? today,
    dim: url.searchParams.get("dim") ?? undefined,
    accountId: url.searchParams.get("accountId") ?? undefined,
    warehouseId: url.searchParams.get("warehouseId") ?? undefined,
    partyId: url.searchParams.get("partyId") ?? undefined,
    slowDays: url.searchParams.get("slowDays") ?? undefined,
    includeZero: url.searchParams.get("includeZero") ?? undefined,
  };
  const code = url.searchParams.get("report") ?? "R-02";
  const definition = REPORT_CATALOG.find((d) => d.code === code);
  if (!definition || definition.status !== "ready") {
    return new Response("report unavailable", { status: 400 });
  }
  if (FINANCIAL.has(code) && !hasPermission(ctx, "reports.financial.view")) {
    return new Response("permission denied", { status: 403 });
  }

  const locale = await getLocale();
  const rep = getDict(locale).rep as unknown as Record<string, string>;
  const titles = (columns: ReportResult["columns"]) =>
    columns.map((c) => rep[c.titleKey.split(".").slice(1).join(".")] ?? c.titleKey);

  const payload = await withTenant(ctx.tenant.id, async (trx) => {
    if (!requestedFrom) {
      const rows = (await trx.execute(
        sql`select min(business_date) as first_day from journal_entries where tenant_id = ${ctx.tenant!.id} and status = 'posted'`,
      )) as unknown as { rows: { first_day: string | null }[] };
      params.from = rows.rows[0]?.first_day ?? `${today.slice(0, 7)}-01`;
    }
    const result = await runReport(trx, ctx.tenant!.id, code, params);
    await writeAudit(trx, {
      tenantId: ctx.tenant!.id,
      actorUserId: ctx.userId,
      actorLabel: ctx.userEmail || ctx.userName || ctx.userId || "system",
      action: "reports.exported",
      entity: "report",
      entityId: code,
      after: { format: "csv", params, rows: result.rows.length },
    });
    return toCsv(result, titles(result.columns));
  });

  const filename = `${code}-${params.from ?? ""}-${params.to ?? ""}.csv`;
  return new Response(payload, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
