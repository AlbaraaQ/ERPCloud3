/**
 * Backups console (BACKUP_AND_RECOVERY §3–§7, PLATFORM_ADMIN §2.4).
 *
 * Run-now / verify / drill / retention, the artifact inventory, the remote
 * transport in force, and the run history with checksums. A backup is only
 * "verified" when the artifact was re-read, decrypted and content-checked; a
 * local-only artifact is labelled as such and never presented as off-site.
 */

import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import {
  artifactInventory,
  backupFreshness,
  listBackupRuns,
  remoteProviderStatus,
} from "@/modules/platform/backup/service";
import { getSettings } from "@/modules/platform/settings";
import {
  backupDrillAction,
  backupPolicyAction,
  backupPruneAction,
  backupRunAction,
  backupRestoreAction,
  backupVerifyAction,
} from "@/modules/platform/actions";
import { ActionForm, Badge, Field, StatCard, Table } from "../../ui";
import { fmtBytes, fmtDate, statusTone } from "../../format";

export const dynamic = "force-dynamic";

export default async function BackupsPage() {
  const t = getDict(await getLocale()).platform;
  const ctx = requirePlatformPermission(await getPlatformContext(), "platform.backups.view");

  const [runs, freshness, inventory, settings, remote] = await Promise.all([
    listBackupRuns(40),
    backupFreshness(),
    artifactInventory(),
    getSettings(),
    remoteProviderStatus(),
  ]);

  const verified = runs.filter((r) => r.status === "verified");
  const lastDrill = runs.find((r) => r.drillAt);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">{t.navBackups}</h1>
        <p className="text-xs text-muted">{t.backupHint}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t.backupFreshness}
          value={freshness.lastVerifiedAt ? `${freshness.ageHours?.toFixed(1)}h` : t.never}
          hint={fmtDate(freshness.lastVerifiedAt)}
          tone={freshness.stale || !freshness.lastVerifiedAt ? "danger" : "success"}
        />
        <StatCard label={t.verifiedRuns} value={verified.length} hint={`${t.of} ${runs.length}`} />
        <StatCard
          label={t.lastDrill}
          value={lastDrill?.drillStatus ?? "—"}
          hint={lastDrill ? fmtDate(lastDrill.drillAt) : t.noDrill}
          tone={lastDrill?.drillStatus === "passed" ? "success" : lastDrill ? "danger" : "default"}
        />
        <StatCard
          label={t.remote}
          value={remote.provider}
          hint={remote.offsite ? `${remote.objects} ${t.objects}` : t.localOnly}
          tone={remote.configured ? "success" : "warning"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-bold">{t.backupActions}</h2>
          <div className="flex flex-wrap gap-2">
            {ctx.permissions.has("platform.backup.run") ? (
              <ActionForm action={backupRunAction} submitLabel={t.runBackup} />
            ) : null}
            {ctx.permissions.has("platform.backup.verify") ? (
              <ActionForm action={backupDrillAction} submitLabel={t.drill} />
            ) : null}
            {ctx.permissions.has("platform.backup.run") ? (
              <ActionForm action={backupPruneAction} submitLabel={t.prune} />
            ) : null}
          </div>
          <dl className="mt-4 space-y-1 text-xs">
            <div className="flex justify-between border-b border-border/60 py-1">
              <dt className="text-muted">{t.inventory}</dt>
              <dd className="tnum">
                {inventory.files.length} · {fmtBytes(inventory.files.reduce((s, f) => s + f.bytes, 0))}
              </dd>
            </div>
            <div className="flex justify-between border-b border-border/60 py-1">
              <dt className="text-muted">{t.orphanArtifacts}</dt>
              <dd className="tnum">{inventory.orphans.length}</dd>
            </div>
            <div className="flex justify-between py-1">
              <dt className="text-muted">{t.directory}</dt>
              <dd className="font-mono text-[11px]" dir="ltr">
                {settings.backup.directory}
              </dd>
            </div>
          </dl>
          <p className="mt-3 rounded-xl border border-warning/40 bg-warning-soft/40 px-3 py-2 text-[11px] text-warning">
            {t.restoreNote}
          </p>
          {ctx.role === "owner" ? (
            <div className="mt-3">
              <ActionForm
                action={backupRestoreAction}
                className="opacity-80"
                submitLabel={t.restoreProduction}
                confirm={t.restoreRunbook}
              />
            </div>
          ) : null}
        </section>

        <ActionForm action={backupPolicyAction} className="card p-4" submitLabel={t.save}>
          <h2 className="mb-3 text-sm font-bold">{t.policy}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.keepLatest}>
              <input className="input tnum" name="keepLatest" type="number" min={1} defaultValue={settings.backup.keepLatest} />
            </Field>
            <Field label={t.keepDaily}>
              <input className="input tnum" name="keepDaily" type="number" min={0} defaultValue={settings.backup.keepDaily} />
            </Field>
            <Field label={t.keepWeekly}>
              <input className="input tnum" name="keepWeekly" type="number" min={0} defaultValue={settings.backup.keepWeekly} />
            </Field>
            <Field label={t.staleAfter}>
              <input
                className="input tnum"
                name="staleAfterHours"
                type="number"
                min={1}
                max={72}
                defaultValue={settings.backup.staleAfterHours}
              />
            </Field>
            <Field label={t.directory}>
              <input className="input" name="directory" dir="ltr" defaultValue={settings.backup.directory} />
            </Field>
            <Field label={t.driveFolder}>
              <input className="input" name="driveFolderId" dir="ltr" defaultValue={settings.driveFolderId ?? ""} />
            </Field>
            <Field label={t.coolingOff}>
              <input
                className="input tnum"
                name="coolingOffDays"
                type="number"
                min={0}
                defaultValue={settings.deletionCoolingOffDays}
              />
            </Field>
            <Field label={t.grantMaxHours}>
              <input
                className="input tnum"
                name="grantMaxHours"
                type="number"
                min={1}
                max={24}
                defaultValue={settings.supportGrantMaxHours}
              />
            </Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input type="checkbox" name="uploadToRemote" defaultChecked={settings.backup.uploadToRemote} />{" "}
            {t.uploadRemote}
          </label>
        </ActionForm>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-bold">{t.backupHistory}</h2>
        <Table
          head={[
            t.at,
            t.kind,
            t.backupStatus,
            t.backupFormat,
            t.backupSize,
            t.rowsLabel,
            t.backupDuration,
            t.backupDrillCol,
            t.backupRemote,
            t.actions,
          ]}
        >
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-border/60">
              <td className="px-3 py-2 text-xs tnum">{fmtDate(r.startedAt)}</td>
              <td className="px-3 py-2 font-mono text-[11px]">{r.kind}</td>
              <td className="px-3 py-2">
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                {r.errorClass ? <p className="mt-1 text-[10px] text-danger">{r.errorClass}</p> : null}
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">{r.format ?? "—"}</td>
              <td className="px-3 py-2 text-xs tnum">{fmtBytes(r.artifactBytes)}</td>
              <td className="px-3 py-2 text-xs tnum">
                {r.tableStats ? Object.values(r.tableStats).reduce((s, x) => s + (x.rows ?? 0), 0) : "—"}
                <span className="text-muted"> / {r.tableStats ? Object.keys(r.tableStats).length : "—"}</span>
              </td>
              <td className="px-3 py-2 text-xs tnum">{r.durationMs ? `${r.durationMs} ms` : "—"}</td>
              <td className="px-3 py-2 text-xs">
                {r.drillStatus ? (
                  <>
                    <Badge tone={statusTone(r.drillStatus)}>{r.drillStatus}</Badge>
                    <p className="mt-1 text-[10px] text-muted">{fmtDate(r.drillAt)}</p>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-3 py-2 text-xs">
                {r.remoteProvider ? (
                  <>
                    <span className="font-mono text-[11px]">{r.remoteProvider}</span>
                    <p className="text-[10px] text-muted">
                      {r.remoteVerifiedAt ? `${t.remoteVerified} ${fmtDate(r.remoteVerifiedAt)}` : t.remoteUnverified}
                    </p>
                  </>
                ) : (
                  <Badge tone="muted">{t.localOnly}</Badge>
                )}
              </td>
              <td className="px-3 py-2">
                {ctx.permissions.has("platform.backup.verify") ? (
                  <div className="flex flex-wrap gap-2">
                    <ActionForm action={backupVerifyAction} hidden={{ runId: r.id }} submitLabel={t.verify} />
                    <ActionForm action={backupDrillAction} hidden={{ runId: r.id }} submitLabel={t.drillShort} />
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {runs.length === 0 ? (
            <tr>
              <td className="px-3 py-4 text-muted" colSpan={10}>
                {t.never}
              </td>
            </tr>
          ) : null}
        </Table>
        {runs[0]?.artifactSha256 ? (
          <p className="mt-2 break-all text-[11px] text-muted" dir="ltr">
            sha256({runs[0].format}) {runs[0].artifactSha256}
            {runs[0].plaintextSha256 ? ` · plaintext ${runs[0].plaintextSha256}` : ""}
          </p>
        ) : null}
      </section>
    </div>
  );
}
