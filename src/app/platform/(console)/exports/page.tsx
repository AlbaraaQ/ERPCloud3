/**
 * Export & deletion console (PLATFORM_ADMIN §5).
 *
 * Export bundles are generated inside the tenant's own RLS context, so a bundle
 * cannot contain another tenant's rows; the manifest carries per-table row counts
 * and SHA-256 and the download link expires. Deletion is a workflow: request →
 * cooling-off → legal-hold gate → safety backup → purge → certificate.
 */

import { db } from "@/db";
import { deletionRequests, tenantExports, tenants } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import { listTenants } from "@/modules/platform/tenants";
import { getSettings } from "@/modules/platform/settings";
import { exportBuildAction, deletionLegalHoldAction, deletionRequestAction, deletionPurgeAction } from "@/modules/platform/actions";
import { ActionForm, Badge, Field, Table } from "../../ui";
import { fmtBytes, fmtDate, statusTone } from "../../format";

export const dynamic = "force-dynamic";

export default async function ExportsPage() {
  const t = getDict(await getLocale()).platform;
  const ctx = requirePlatformPermission(await getPlatformContext(), "platform.exports.view");
  const settings = await getSettings();

  const [exports, deletions, tenantRows] = await Promise.all([
    db
      .select({
        id: tenantExports.id,
        tenantId: tenantExports.tenantId,
        tenantName: tenants.name,
        status: tenantExports.status,
        bytes: tenantExports.bytes,
        sha256: tenantExports.sha256,
        createdAt: tenantExports.createdAt,
        expiresAt: tenantExports.expiresAt,
        manifest: tenantExports.manifest,
        requestedByLabel: tenantExports.requestedByLabel,
      })
      .from(tenantExports)
      .leftJoin(tenants, eq(tenants.id, tenantExports.tenantId))
      .orderBy(desc(tenantExports.createdAt))
      .limit(50),
    db
      .select({
        id: deletionRequests.id,
        tenantId: deletionRequests.tenantId,
        tenantName: tenants.name,
        status: deletionRequests.status,
        reason: deletionRequests.reason,
        coolingOffUntil: deletionRequests.coolingOffUntil,
        legalHold: deletionRequests.legalHold,
        exportOffered: deletionRequests.exportOffered,
        certificate: deletionRequests.certificate,
        createdAt: deletionRequests.createdAt,
      })
      .from(deletionRequests)
      .leftJoin(tenants, eq(tenants.id, deletionRequests.tenantId))
      .orderBy(desc(deletionRequests.createdAt))
      .limit(50),
    listTenants(),
  ]);

  const rowsOf = (m: { tables?: { rows: number }[] } | null) =>
    (m?.tables ?? []).reduce((s, x) => s + x.rows, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">{t.exportsTitle}</h1>
        <p className="text-xs text-muted">{t.exportsHint}</p>
      </header>

      <ActionForm action={exportBuildAction} className="card p-4" submitLabel={t.buildExport}>
        <h2 className="mb-3 text-sm font-bold">{t.buildExport}</h2>
        <Field label={t.tenants} hint={t.exportHint}>
          <select className="input max-w-md" name="tenantId" required>
            {tenantRows.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} — {x.status}
              </option>
            ))}
          </select>
        </Field>
      </ActionForm>

      <Table head={[t.tenants, t.statusLabel, t.exportRows, t.backupSize, t.shaLabel, t.at, t.expires, t.actions]}>
        {exports.map((e) => (
          <tr key={e.id} className="border-t border-border/60">
            <td className="px-3 py-2 text-sm">{e.tenantName ?? e.tenantId.slice(0, 8)}</td>
            <td className="px-3 py-2">
              <Badge tone={statusTone(e.status)}>{e.status}</Badge>
            </td>
            <td className="px-3 py-2 tnum">{rowsOf(e.manifest ?? null)}</td>
            <td className="px-3 py-2 text-xs tnum">{fmtBytes(e.bytes)}</td>
            <td className="px-3 py-2 font-mono text-[10px] text-muted" dir="ltr">
              {e.sha256?.slice(0, 16) ?? "—"}
            </td>
            <td className="px-3 py-2 text-xs tnum">{fmtDate(e.createdAt)}</td>
            <td className="px-3 py-2 text-xs tnum">{fmtDate(e.expiresAt)}</td>
            <td className="px-3 py-2">
              {e.status === "ready" && ctx.permissions.has("platform.exports.manage") ? (
                <a className="text-xs underline" href={`/api/platform/export/${e.id}`}>
                  {t.download}
                </a>
              ) : (
                "—"
              )}
            </td>
          </tr>
        ))}
        {exports.length === 0 ? (
          <tr>
            <td className="px-3 py-4 text-muted" colSpan={8}>
              {t.noExports}
            </td>
          </tr>
        ) : null}
      </Table>

      <section className="space-y-3">
        <h2 className="text-sm font-bold">{t.deletion}</h2>
        <ActionForm action={deletionRequestAction} className="card p-4" submitLabel={t.requestDeletion}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.tenants} hint={`${t.coolingOff}: ${settings.deletionCoolingOffDays} ${t.days}`}>
              <select className="input" name="tenantId" required>
                {tenantRows.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} — {x.status}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.reason}>
              <input className="input" name="reason" required />
            </Field>
          </div>
        </ActionForm>

        <Table head={[t.tenants, t.statusLabel, t.coolingOffUntil, t.legalHold, t.exportOffered, t.actions]}>
          {deletions.map((d) => (
            <tr key={d.id} className="border-t border-border/60">
              <td className="px-3 py-2 text-sm">{d.tenantName ?? (d.tenantId ? d.tenantId.slice(0, 8) : "—")}</td>
              <td className="px-3 py-2">
                <Badge tone={statusTone(d.status)}>{d.status}</Badge>
              </td>
              <td className="px-3 py-2 text-xs tnum">{fmtDate(d.coolingOffUntil)}</td>
              <td className="px-3 py-2 text-xs">{d.legalHold ? <Badge tone="danger">{t.legalHoldShort}</Badge> : "—"}</td>
              <td className="px-3 py-2 text-xs">{d.exportOffered ? t.yes : t.no}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-2">
                  <ActionForm
                    action={deletionLegalHoldAction}
                    hidden={{ requestId: d.id, hold: d.legalHold ? "false" : "true" }}
                    submitLabel={d.legalHold ? t.clearHold : t.legalHold}
                  />
                  <ActionForm action={deletionPurgeAction} hidden={{ requestId: d.id }} submitLabel={t.purge}>
                    <Field label={t.purgeHint}>
                      <input className="input" name="confirmation" required />
                    </Field>
                  </ActionForm>
                </div>
              </td>
            </tr>
          ))}
          {deletions.length === 0 ? (
            <tr>
              <td className="px-3 py-4 text-muted" colSpan={6}>
                {t.noDeletions}
              </td>
            </tr>
          ) : null}
        </Table>
      </section>
    </div>
  );
}
