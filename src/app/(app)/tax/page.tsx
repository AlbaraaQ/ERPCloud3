import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { requirePermission, hasPermission } from "@/modules/shared/context";
import { withTenant } from "@/modules/shared/db-context";
import { sql } from "drizzle-orm";
import {
  taxConfigs as taxConfigsTable,
  zatcaCertificates,
  invoiceSubmissions,
  companies,
} from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
import { TaxConfigForm, OnboardingPanel, RetryButtons } from "./tax-forms";
import { getOnboardingStatus } from "@/modules/tax/onboarding";
import { Receipt, CloudCheck, ShieldAlert, ShieldCheck, Hourglass, CloudOff } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "الفوترة الإلكترونية" };

export default async function TaxPage() {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  requirePermission(ctx, "tax.view");

  const locale = await getLocale();
  const t = getDict(locale);
  const errorsFlat = t.errors as unknown as Record<string, string>;

  const data = await withTenant(ctx.tenant.id, async (trx) => {
    const [cfg] = await trx.select().from(taxConfigsTable).where(eq(taxConfigsTable.tenantId, ctx.tenant!.id)).limit(1);
    const [co] = await trx.select().from(companies).where(eq(companies.tenantId, ctx.tenant!.id)).limit(1);
    const certs = await trx
      .select({ env: zatcaCertificates.env, kind: zatcaCertificates.kind, status: zatcaCertificates.status, label: zatcaCertificates.label, createdAt: zatcaCertificates.createdAt })
      .from(zatcaCertificates)
      .where(eq(zatcaCertificates.tenantId, ctx.tenant!.id));
    const subs = await trx
      .select()
      .from(invoiceSubmissions)
      .where(eq(invoiceSubmissions.tenantId, ctx.tenant!.id))
      .orderBy(desc(invoiceSubmissions.createdAt))
      .limit(40);
    const stats = (await trx.execute(sql`
      select status, count(*)::text as n from invoice_submissions where tenant_id = ${ctx.tenant!.id} group by status
    `)) as unknown as { rows: { status: string; n: string }[] };
    const vat = (await trx.execute(sql`
      select a.code, coalesce(sum(l.debit::numeric - l.credit::numeric), 0)::text as bal
      from accounts a left join journal_lines l on l.account_id = a.id
      where a.tenant_id = ${ctx.tenant!.id} and a.code in ('2102', '1106')
      group by a.code
    `)) as unknown as { rows: { code: string; bal: string }[] };
    const onboarding = await getOnboardingStatus(trx, ctx.tenant!.id);
    return { cfg: cfg ?? null, company: co ?? null, certs, subs, stats: stats.rows, vat: vat.rows, onboarding };
  });

  const canConfigure = hasPermission(ctx, "tax.configure");
  const statOf = (s: string) => Number(data.stats.find((x) => x.status === s)?.n ?? 0);
  const vatOf = (code: string) => {
    const row = data.vat.find((v) => v.code === code);
    return row ? Number(row.bal) : 0;
  };

  const statusMeta: Record<string, { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }> = {
    issued_pending_reporting: { label: t.taxPg.pending, tone: "bg-warning-soft text-warning", icon: Hourglass },
    clearance_pending: { label: t.taxPg.pending, tone: "bg-warning-soft text-warning", icon: Hourglass },
    reported: { label: t.taxPg.reported, tone: "bg-success-soft text-success", icon: ShieldCheck },
    cleared: { label: t.taxPg.cleared, tone: "bg-success-soft text-success", icon: ShieldCheck },
    rejected: { label: t.taxPg.rejected, tone: "bg-danger-soft text-danger", icon: ShieldAlert },
    failed_retryable: { label: t.taxPg.failed, tone: "bg-danger-soft text-danger", icon: CloudOff },
    blocked_config: { label: t.taxPg.blocked, tone: "bg-surface-3 text-muted", icon: ShieldAlert },
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Receipt className="h-6 w-6 text-primary" /> {t.taxPg.title}
        </h1>
        <p className="mt-1 text-sm text-muted">{t.taxPg.docSubtitle}</p>
      </div>

      {/* status cards */}
      <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: t.taxPg.pending, count: statOf("issued_pending_reporting") + statOf("clearance_pending"), tone: "text-warning" },
          { label: t.taxPg.reported, count: statOf("reported"), tone: "text-success" },
          { label: t.taxPg.cleared, count: statOf("cleared"), tone: "text-success" },
          { label: t.taxPg.rejected, count: statOf("rejected"), tone: "text-danger" },
          { label: t.taxPg.failed, count: statOf("failed_retryable"), tone: "text-danger" },
          { label: t.taxPg.blocked, count: statOf("blocked_config"), tone: "text-muted" },
        ].map((s) => (
          <div key={s.label} className="card p-4 text-center">
            <p className={`tnum text-2xl font-bold ${s.tone}`}>{s.count}</p>
            <p className="text-[11px] text-muted">{s.label}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <TaxConfigForm t={t} errors={errorsFlat} cfg={data.cfg} company={data.company} canConfigure={canConfigure} />
        <div className="space-y-5">
          <OnboardingPanel
            t={t}
            errors={errorsFlat}
            canConfigure={canConfigure}
            status={data.onboarding}
            certs={data.certs.map((c) => ({ env: c.env, kind: c.kind, status: c.status, label: c.label }))}
          />
          {/* VAT summary */}
          <section className="card space-y-2 p-5">
            <h2 className="font-semibold">{t.taxPg.vatSummary}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-surface-2 p-4 text-center">
                <p className="tnum text-xl font-bold" dir="ltr">{vatOf("2102").toFixed(2)}</p>
                <p className="text-[11px] text-muted">{t.taxPg.outputVat} (2102)</p>
              </div>
              <div className="rounded-xl bg-surface-2 p-4 text-center">
                <p className="tnum text-xl font-bold" dir="ltr">{vatOf("1106").toFixed(2)}</p>
                <p className="text-[11px] text-muted">{t.taxPg.inputVat} (1106)</p>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* submissions */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <CloudCheck className="h-5 w-5 text-primary" /> {t.taxPg.submissions}
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-muted">
                <th className="px-4 py-2.5 text-start font-medium">{t.taxPg.icv}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.taxPg.docType}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.taxPg.uuid}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.taxPg.hash}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.taxPg.statusCol}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.taxPg.attempts}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t.taxPg.lastError}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.subs.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-muted">{t.common.empty}</td></tr>
              )}
              {data.subs.map((s) => {
                const meta = statusMeta[s.status] ?? statusMeta.blocked_config;
                const Icon = meta.icon;
                return (
                  <tr key={s.id} className="border-b border-border/60 last:border-0">
                    <td className="tnum px-4 py-2.5 font-bold" dir="ltr">{s.icv}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {s.docSubtype === "credit_note" ? t.taxPg.creditNote : s.docType === "simplified" ? t.taxPg.simplified : t.taxPg.standard}
                    </td>
                    <td className="tnum px-4 py-2.5 text-xs text-muted" dir="ltr">{s.invoiceUuid.slice(0, 13)}…</td>
                    <td className="tnum px-4 py-2.5 text-xs text-muted" dir="ltr">{s.invoiceHash.slice(0, 10)}…</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold ${meta.tone}`}>
                        <Icon className="h-3.5 w-3.5" /> {meta.label}
                      </span>
                    </td>
                    <td className="tnum px-4 py-2.5 text-center" dir="ltr">{s.attempts}</td>
                    <td className="max-w-64 truncate px-4 py-2.5 text-xs text-danger">{s.lastError ?? "—"}</td>
                    <td className="px-4 py-2.5 text-end">
                      {s.status === "failed_retryable" && (
                        <RetryButtons t={t} errors={errorsFlat} submissionId={s.id} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
