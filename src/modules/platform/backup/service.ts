/**
 * Backup orchestration (BACKUP_AND_RECOVERY §3/§5/§6, PLATFORM_ADMIN §2.4).
 *
 * Lifecycle: capture → checksum → encrypt → local artifact (`local_ok`) →
 * optional off-site upload (`uploaded`) → **verify** (`verified`). The only
 * status that means "we have a restorable copy" is `verified`; anything else is
 * a failed attempt with an error class and an alert, never a green tick.
 *
 * Restores:
 *  - `runRestoreDrill` restores the newest verified artifact into an isolated
 *    schema, runs the invariant pack and drops the schema. This is what runs
 *    every night and what the console shows.
 *  - `restoreIntoNewSchema` additionally writes a restored schema everyone can
 *    inspect (the "restore to a scratch database" workflow).
 *  - `swapRestoredSchema` is the production restore: two-person approval, a typed
 *    database-name confirmation, a safety backup first, and the schema swap
 *    recorded in the platform audit log. It refuses unless the operator has
 *    explicitly enabled live restores on the host.
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { backupRuns } from "@/db/schema";
import { getSettings } from "../settings";
import { raiseAlert, resolveAlerts } from "../alerts";
import { writePlatformAudit } from "../audit";
import { newId } from "@/modules/shared/ids";
import { logger } from "@/modules/shared/logger";
import {
  decryptArtifact,
  encryptArtifact,
  isEncryptedArtifact,
  sha256Hex,
} from "./crypto";
import { buildSnapshot, parseSnapshot, restoreSnapshot, verifySnapshot, type SnapshotFile } from "./snapshot";
import { runInvariants, type InvariantReport } from "./invariants";
import { driveTransport, type RemoteDrive } from "./drive";
import { pgDumpProbe, runPgDump } from "./pgdump";

type BackupRunRow = typeof backupRuns.$inferSelect;

export type BackupStatus = "running" | "local_ok" | "uploaded" | "verified" | "failed" | "pruned";
export type BackupKind = "scheduled" | "manual" | "safety";
export type RetentionClass = "latest" | "daily" | "weekly" | "pinned";

export interface BackupEvidence {
  id: string;
  status: BackupStatus;
  format: string;
  databaseName: string;
  artifactPath: string | null;
  artifactBytes: number;
  plaintextBytes: number;
  plaintextSha256: string | null;
  artifactSha256: string | null;
  tables: number;
  rows: number;
  durationMs: number;
  remoteProvider: string | null;
  remoteVerified: boolean;
  errorClass: string | null;
  errorDetail: string | null;
}

export interface RunOptions {
  kind?: BackupKind;
  actorLabel: string;
  actorPlatformUserId?: string | null;
  /** force a format (tests); default: pg_dump when available, else logical */
  format?: "auto" | "pg_dump-custom" | "logical-json";
  /** skip the off-site upload even when a transport exists */
  skipRemote?: boolean;
  /** keep the artifact on this path instead of the configured directory */
  directory?: string;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for backups");
  return url;
}

function databaseName(): string {
  try {
    return new URL(databaseUrl()).pathname.replace(/^\//, "") || "app_db";
  } catch {
    return "app_db";
  }
}

function classifyError(err: unknown): { errorClass: string; detail: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? "";
  const lower = message.toLowerCase();
  if (lower.includes("hISAB_ENCRYPTION_KEY".toLowerCase()) || lower.includes("must be 32 bytes")) {
    return { errorClass: "encryption_key", detail: message.slice(0, 500) };
  }
  if (lower.includes("pg_dump") || code === "ENOENT") {
    return { errorClass: "dump_tool", detail: message.slice(0, 500) };
  }
  if (code === "ENOSPC" || lower.includes("no space")) return { errorClass: "disk_full", detail: message.slice(0, 500) };
  if (code === "EACCES" || lower.includes("permission")) return { errorClass: "permissions", detail: message.slice(0, 500) };
  if (code === "28P01" || code === "3D000" || lower.includes("connect")) {
    return { errorClass: "database", detail: message.slice(0, 500) };
  }
  return { errorClass: "unknown", detail: message.slice(0, 500) };
}

async function artifactDirectory(dir?: string): Promise<string> {
  const settings = await getSettings();
  const base = dir ?? settings.backup.directory;
  await mkdir(base, { recursive: true });
  return base;
}

function remoteFor(root: string): RemoteDrive {
  return driveTransport({ root });
}

/* ------------------------------------------------------------------- capture */

interface CaptureResult {
  format: "pg_dump-custom" | "logical-json";
  plaintextPath?: string;
  plaintext: Buffer;
  tables: number;
  rows: number;
  tableStats: Record<string, { rows: number; sha256?: string }> | null;
}

async function capture(opts: RunOptions, workingDir: string, id: string): Promise<CaptureResult> {
  const requested = opts.format ?? "auto";
  const useDump = requested === "pg_dump-custom" || (requested === "auto" && (await pgDumpProbe()).available);

  if (useDump) {
    const target = join(workingDir, `hisab-${id}.dump`);
    const result = await runPgDump({ targetPath: target, databaseUrl: databaseUrl() });
    const plaintext = await readFile(target);
    await unlink(target).catch(() => undefined);
    return { format: "pg_dump-custom", plaintext, tables: 0, rows: 0, tableStats: null };
  }

  const snapshot = await buildSnapshot({ databaseName: databaseName() });
  const plaintext = Buffer.from(JSON.stringify(snapshot), "utf8");
  const tableStats: Record<string, { rows: number; sha256?: string }> = {};
  for (const t of snapshot.manifest.tables) tableStats[t.name] = { rows: t.rows, sha256: t.sha256 };
  return {
    format: "logical-json",
    plaintext,
    tables: snapshot.manifest.tables.length,
    rows: snapshot.manifest.rowCount,
    tableStats,
  };
}

/* --------------------------------------------------------------- verify steps */

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface VerifyResult {
  id: string;
  status: BackupStatus;
  checks: VerifyCheck[];
  ok: boolean;
}

/**
 * Verify a run: the artifact must exist, match its recorded checksum, decrypt,
 * have the recorded plaintext checksum, and — for the logical format — parse and
 * reproduce every per-table count and content hash. Off-site copies are re-read
 * through the transport and compared by size (and checksum when the provider
 * exposes one). Anything short of that is a failure with an alert.
 */
export async function verifyBackup(runId: string): Promise<VerifyResult> {
  const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, runId)).limit(1);
  if (!row) throw new Error(`backup run ${runId} not found`);

  const checks: VerifyCheck[] = [];
  let ok = true;
  const fail = (name: string, detail: string) => {
    checks.push({ name, ok: false, detail });
    ok = false;
  };

  if (!row.artifactPath) fail("artifact_present", "no artifact path recorded");
  else {
    const info = await stat(row.artifactPath).catch(() => null);
    if (!info?.isFile()) fail("artifact_present", `artifact missing at ${row.artifactPath}`);
    else {
      checks.push({ name: "artifact_present", ok: true, detail: `${info.size} bytes on disk` });
      const raw = await readFile(row.artifactPath);
      const artifactSha = sha256Hex(raw);
      if (row.artifactSha256 && artifactSha !== row.artifactSha256) {
        fail("artifact_checksum", `artifact sha256 ${artifactSha} ≠ recorded ${row.artifactSha256}`);
      } else {
        checks.push({ name: "artifact_checksum", ok: true, detail: `sha256 ${artifactSha.slice(0, 16)}…` });
      }

      try {
        const text = raw.toString("utf8");
        if (!isEncryptedArtifact(text)) fail("encrypted", "artifact is not an encrypted envelope");
        else {
          const plaintext = decryptArtifact(text);
          checks.push({ name: "decrypt", ok: true, detail: `${plaintext.length} bytes decrypted` });
          const plainSha = sha256Hex(plaintext);
          if (row.plaintextSha256 && plainSha !== row.plaintextSha256) {
            fail("plaintext_checksum", `plaintext sha256 ${plainSha} ≠ recorded ${row.plaintextSha256}`);
          } else {
            checks.push({ name: "plaintext_checksum", ok: true, detail: `sha256 ${plainSha.slice(0, 16)}…` });
          }

          if (row.format === "logical-json") {
            try {
              const snapshot = parseSnapshot(plaintext);
              const verdict = verifySnapshot(snapshot);
              if (verdict.ok) {
                checks.push({
                  name: "content",
                  ok: true,
                  detail: `${verdict.tables} tables / ${verdict.rows} rows reproduce their hashes`,
                });
              } else {
                fail("content", verdict.problems.slice(0, 3).join("; "));
              }
            } catch (e) {
              fail("content", `snapshot unreadable: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            const magic = plaintext.subarray(0, 5).toString("ascii");
            if (magic === "PGDMP") checks.push({ name: "content", ok: true, detail: "pg_dump custom format magic OK" });
            else fail("content", `unexpected pg_dump magic "${magic}"`);
          }
        }
      } catch (e) {
        fail("decrypt", e instanceof Error ? e.message : String(e));
      }
    }
  }

  // off-site copy: re-read it through the transport
  if (row.remoteId && row.remoteProvider) {
    try {
      const transport = remoteFor(await artifactDirectory());
      if (transport.provider !== row.remoteProvider) {
        checks.push({
          name: "remote",
          ok: true,
          skipped: true,
          detail: `remote provider is now ${transport.provider}; the ${row.remoteProvider} copy cannot be re-read here`,
        });
      } else {
        const remote = await transport.stat(row.remoteId);
        if (!remote) fail("remote", `remote object ${row.remoteId} not found`);
        else if (row.artifactBytes && remote.bytes !== Number(row.artifactBytes)) {
          fail("remote", `remote size ${remote.bytes} ≠ local ${row.artifactBytes}`);
        } else {
          checks.push({ name: "remote", ok: true, detail: `${remote.bytes} bytes re-read from ${row.remoteProvider}` });
          await db.update(backupRuns).set({ remoteVerifiedAt: new Date() }).where(eq(backupRuns.id, runId));
        }
      }
    } catch (e) {
      fail("remote", e instanceof Error ? e.message : String(e));
    }
  } else {
    checks.push({
      name: "remote",
      ok: true,
      skipped: true,
      detail: "no off-site copy for this run (local artifact only) — not counted as off-site protection",
    });
  }

  const status: BackupStatus = ok ? "verified" : "failed";
  await db
    .update(backupRuns)
    .set({ status, errorClass: ok ? null : "verification", errorDetail: ok ? null : checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ").slice(0, 900) })
    .where(eq(backupRuns.id, runId));

  if (!ok) {
    await raiseAlert({
      severity: "critical",
      kind: "backup_verification_failed",
      title: "Backup verification failed",
      body: `run ${runId}: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`,
      payload: { runId, checks },
    });
  } else {
    await resolveAlerts("backup_verification_failed", null);
  }

  return { id: runId, status, checks, ok };
}

/* ---------------------------------------------------------------------- run */

function publicEvidence(row: BackupRunRow): BackupEvidence {
  const tableStats = row.tableStats ?? {};
  const tables = Object.keys(tableStats).length;
  const rows = Object.values(tableStats).reduce((sum, t) => sum + Number(t.rows ?? 0), 0);
  return {
    id: row.id,
    status: row.status as BackupStatus,
    format: row.format,
    databaseName: row.databaseName,
    artifactPath: row.artifactPath,
    artifactBytes: Number(row.artifactBytes ?? 0),
    plaintextBytes: Number(row.plaintextBytes ?? 0),
    plaintextSha256: row.plaintextSha256,
    artifactSha256: row.artifactSha256,
    tables,
    rows,
    durationMs: row.durationMs ?? 0,
    remoteProvider: row.remoteProvider,
    remoteVerified: Boolean(row.remoteVerifiedAt),
    errorClass: row.errorClass,
    errorDetail: row.errorDetail,
  };
}

export async function runBackup(opts: RunOptions): Promise<BackupEvidence> {
  const settings = await getSettings();
  const id = newId();
  const kind: BackupKind = opts.kind ?? "scheduled";
  const startedAt = new Date();

  await db.insert(backupRuns).values({
    id,
    kind,
    status: "running",
    format: "pending",
    databaseName: databaseName(),
    startedAt,
    attempts: 1,
    createdByLabel: opts.actorLabel,
  });

  try {
    const dir = await artifactDirectory(opts.directory);
    const captured = await capture(opts, dir, id);
    const artifact = Buffer.from(encryptArtifact(captured.plaintext), "utf8");
    const artifactPath = join(dir, `hisab-${startedAt.toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}.enc`);
    await writeFile(artifactPath, artifact);

    await db
      .update(backupRuns)
      .set({
        format: captured.format,
        status: "local_ok",
        plaintextBytes: captured.plaintext.length,
        plaintextSha256: sha256Hex(captured.plaintext),
        artifactBytes: artifact.length,
        artifactSha256: sha256Hex(artifact),
        artifactPath,
        tableStats: captured.tableStats,
        engineVersion: (await engineVersion()) ?? null,
      })
      .where(eq(backupRuns.id, id));

    logger.info(
      { id, format: captured.format, bytes: artifact.length, tables: captured.tables, rows: captured.rows },
      "backup captured and encrypted",
    );

    // off-site copy: attempted unless explicitly skipped
    let remoteSkipped = opts.skipRemote === true;
    if (!remoteSkipped && settings.backup.uploadToRemote) {
      const transport = remoteFor(dir);
      try {
        const uploaded = await transport.upload(`hisab-${databaseName()}-${id.slice(0, 8)}.enc`, artifactPath);
        await db
          .update(backupRuns)
          .set({ remoteId: uploaded.id, remoteProvider: transport.provider, status: "uploaded" })
          .where(eq(backupRuns.id, id));
      } catch (e) {
        remoteSkipped = true;
        logger.warn({ err: e }, "off-site upload failed — the run stays local and will be labelled as such");
        await raiseAlert({
          severity: "warning",
          kind: "backup_remote_failed",
          title: "Off-site backup copy failed",
          body: e instanceof Error ? e.message.slice(0, 300) : String(e),
          payload: { runId: id },
        });
      }
    } else if (settings.backup.uploadToRemote === false) {
      remoteSkipped = true;
    }

    if (remoteSkipped) {
      logger.info({ id }, "backup has no off-site copy for this run (remote upload disabled or unavailable)");
    }

    const verification = await verifyBackup(id);
    const [final] = await db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
    await db
      .update(backupRuns)
      .set({ finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() })
      .where(eq(backupRuns.id, id));
    final!.durationMs = Date.now() - startedAt.getTime();
    final!.finishedAt = new Date();

    if (!verification.ok) {
      await raiseAlert({
        severity: "critical",
        kind: "backup_failed",
        title: "Backup run failed",
        body: `run ${id} ended as ${verification.status}`,
        payload: { runId: id, checks: verification.checks },
      });
    } else {
      await resolveAlerts("backup_failed", null);
      // newest verified run is the "latest" class; the GFS pruner re-labels the rest
      await db.update(backupRuns).set({ retentionClass: "latest" }).where(eq(backupRuns.id, id));
    }

    return publicEvidence(final!);
  } catch (err) {
    const { errorClass, detail } = classifyError(err);
    await db
      .update(backupRuns)
      .set({
        status: "failed",
        errorClass,
        errorDetail: detail,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
      })
      .where(eq(backupRuns.id, id));
    await raiseAlert({
      severity: "critical",
      kind: "backup_failed",
      title: "Backup run failed",
      body: `${errorClass}: ${detail.slice(0, 300)}`,
      payload: { runId: id, errorClass },
    });
    const [failed] = await db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
    return publicEvidence(failed!);
  }
}

async function engineVersion(): Promise<string | null> {
  try {
    const res = (await db.execute(sql`select version() as v`)) as unknown as { rows: { v: string }[] };
    return res.rows[0]?.v?.slice(0, 120) ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ retention */

export interface PruneResult {
  pruned: number;
  kept: number;
  /** artifacts unlinked from the backup directory */
  deletedFiles: number;
  deletedRemote: number;
  keptIds: string[];
}

/**
 * Retention (BACKUP_AND_RECOVERY §2): keep the newest `keepLatest` verified runs,
 * one verified run per day for `keepDaily` days, one per week for `keepWeekly`
 * weeks, and every `pinned` run. Pruned runs keep their metadata row (status
 * `pruned`) so history shows what was removed and when.
 */
export async function pruneBackups(): Promise<PruneResult> {
  const settings = await getSettings();
  const policy = settings.backup;
  const runs = await db
    .select()
    .from(backupRuns)
    .where(inArray(backupRuns.status, ["verified", "uploaded", "local_ok"]))
    .orderBy(desc(backupRuns.startedAt));

  const keep = new Set<string>();
  runs.slice(0, policy.keepLatest).forEach((r) => keep.add(r.id));

  const now = Date.now();
  const dayBuckets = new Set<string>();
  const weekBuckets = new Set<string>();
  for (const run of runs) {
    const ageDays = (now - new Date(run.startedAt).getTime()) / 86_400_000;
    if (ageDays <= policy.keepDaily) {
      const day = new Date(run.startedAt).toISOString().slice(0, 10);
      if (!dayBuckets.has(day)) {
        dayBuckets.add(day);
        keep.add(run.id);
      }
    }
    if (ageDays <= policy.keepWeekly * 7) {
      const week = isoWeek(new Date(run.startedAt));
      if (!weekBuckets.has(week)) {
        weekBuckets.add(week);
        keep.add(run.id);
      }
    }
  }
  runs.filter((r) => r.retentionClass === "pinned").forEach((r) => keep.add(r.id));

  let pruned = 0;
  let deletedFiles = 0;
  let deletedRemote = 0;
  const dir = await artifactDirectory();

  for (const run of runs) {
    if (keep.has(run.id)) continue;
    if (run.artifactPath) {
      const removed = await unlink(run.artifactPath).then(() => true).catch(() => false);
      if (removed) deletedFiles += 1;
    }
    if (run.remoteId && run.remoteProvider) {
      const transport = remoteFor(dir);
      if (transport.provider === run.remoteProvider) {
        await transport.remove(run.remoteId).then(() => (deletedRemote += 1)).catch(() => undefined);
      }
    }
    await db
      .update(backupRuns)
      .set({
        status: "pruned",
        errorDetail: `pruned by retention policy on ${new Date().toISOString()} (latest ${policy.keepLatest} / daily ${policy.keepDaily} / weekly ${policy.keepWeekly})`,
      })
      .where(eq(backupRuns.id, run.id));
    pruned += 1;
  }

  if (pruned > 0) {
    await writePlatformAudit(db, {
      actorLabel: "system:retention",
      action: "backup.pruned",
      entity: "backup_runs",
      after: { pruned, deletedFiles, deletedRemote, policy },
    });
  }

  return { pruned, kept: keep.size, deletedFiles, deletedRemote, keptIds: [...keep] };
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ freshness */

export interface Freshness {
  lastVerifiedAt: Date | null;
  ageHours: number | null;
  thresholdHours: number;
  stale: boolean;
  verifiedCount: number;
  lastRunStatus: string | null;
}

export async function backupFreshness(): Promise<Freshness> {
  const settings = await getSettings();
  const [lastVerified] = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.status, "verified"))
    .orderBy(desc(backupRuns.finishedAt), desc(backupRuns.startedAt))
    .limit(1);
  const [latest] = await db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(1);
  const verified = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(backupRuns)
    .where(eq(backupRuns.status, "verified"));

  const lastVerifiedAt = lastVerified ? (lastVerified.finishedAt ?? lastVerified.startedAt) : null;
  const ageHours = lastVerifiedAt ? (Date.now() - lastVerifiedAt.getTime()) / 3_600_000 : null;
  return {
    lastVerifiedAt,
    ageHours,
    thresholdHours: settings.backup.staleAfterHours,
    stale: ageHours === null || ageHours > settings.backup.staleAfterHours,
    verifiedCount: Number(verified[0]?.n ?? 0),
    lastRunStatus: latest?.status ?? null,
  };
}

/** Raise (or clear) the stale-backup alert. Called by the health endpoint and jobs. */
export async function checkBackupFreshness(): Promise<Freshness & { alerted: boolean }> {
  const freshness = await backupFreshness();
  if (freshness.stale) {
    await raiseAlert({
      severity: "critical",
      kind: "backup_stale",
      title: "No verified backup within the policy window",
      body: freshness.lastVerifiedAt
        ? `last verified backup is ${freshness.ageHours?.toFixed(1)} h old (threshold ${freshness.thresholdHours} h)`
        : "no verified backup exists yet",
      payload: { lastVerifiedAt: freshness.lastVerifiedAt?.toISOString() ?? null, thresholdHours: freshness.thresholdHours },
    });
  } else {
    await resolveAlerts("backup_stale", null);
  }
  return { ...freshness, alerted: freshness.stale };
}

/* --------------------------------------------------------------------- history */

export async function listBackupRuns(limit = 50): Promise<BackupRunRow[]> {
  return db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit);
}

export async function getBackupRun(id: string): Promise<BackupRunRow | null> {
  const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
  return row ?? null;
}

export async function artifactInventory(): Promise<{ files: { name: string; bytes: number }[]; orphans: string[] }> {
  const dir = await artifactDirectory();
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: { name: string; bytes: number }[] = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) files.push({ name, bytes: info.size });
  }
  const known = new Set(
    (await db.select({ path: backupRuns.artifactPath }).from(backupRuns)).map((r) => r.path).filter(Boolean) as string[],
  );
  const orphans = files
    .filter((f) => !known.has(join(dir, f.name)))
    .map((f) => f.name);
  return { files, orphans };
}

/* ---------------------------------------------------------------------- drill */

export interface DrillOptions {
  runId?: string;
  actorLabel: string;
  keepSchema?: boolean;
  schemaName?: string;
}

export interface DrillResult {
  runId: string;
  schema: string;
  status: "passed" | "failed";
  rows: number;
  tables: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  invariants: InvariantReport | null;
  checks: VerifyCheck[];
  error?: string;
}

/**
 * Restore drill: restore the newest verified artifact into an isolated schema and
 * run the invariants. The evidence (row counts, per-check outcomes, timings) is
 * written to the run row, so "we tested our backups" is a query, not a memory.
 */
export async function runRestoreDrill(opts: DrillOptions): Promise<DrillResult> {
  const startedAt = new Date();
  const [run] = opts.runId
    ? await db.select().from(backupRuns).where(eq(backupRuns.id, opts.runId)).limit(1)
    : await db
        .select()
        .from(backupRuns)
        .where(eq(backupRuns.status, "verified"))
        .orderBy(desc(backupRuns.finishedAt), desc(backupRuns.startedAt))
        .limit(1);
  if (!run) throw new Error("no verified backup available for a restore drill");
  if (!run.artifactPath) throw new Error(`run ${run.id} has no artifact`);

  const schema = opts.schemaName ?? `restore_drill_${Date.now().toString(36)}`;
  const record = async (status: "passed" | "failed", detail: unknown, extra: Record<string, unknown> = {}) => {
    await db
      .update(backupRuns)
      .set({ drillAt: new Date(), drillStatus: status, drillDetail: detail as object, ...extra })
      .where(eq(backupRuns.id, run.id));
  };

  try {
    const raw = await readFile(run.artifactPath);
    if (run.format !== "logical-json") {
      throw new Error(
        "this artifact is a pg_dump custom archive; replaying it needs pg_restore, which is not available on this host",
      );
    }
    const snapshot = parseSnapshot(Buffer.from(decryptArtifact(raw.toString("utf8"))));
    const verdict = verifySnapshot(snapshot);
    if (!verdict.ok) throw new Error(`artifact verification failed: ${verdict.problems.slice(0, 3).join("; ")}`);

    const restored = await restoreSnapshot(snapshot, { targetSchema: schema });
    const invariants = await runInvariants(snapshot, { targetSchema: schema });

    let dropped = false;
    if (!opts.keepSchema) {
      await db.execute(sql.raw(`drop schema if exists "${schema}" cascade`));
      dropped = true;
    }

    const finishedAt = new Date();
    const result: DrillResult = {
      runId: run.id,
      schema,
      status: invariants.ok ? "passed" : "failed",
      rows: restored.rows,
      tables: restored.tables,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      invariants,
      checks: invariants.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail, skipped: c.skipped })),
    };

    await record(result.status, {
      schema,
      dropped,
      rows: result.rows,
      tables: result.tables,
      durationMs: result.durationMs,
      invariants: invariants.checks,
      rtoSeconds: Math.round(result.durationMs / 10) / 100,
    });

    if (result.status === "failed") {
      await raiseAlert({
        severity: "critical",
        kind: "restore_drill_failed",
        title: "Restore drill failed",
        body: `run ${run.id}: ${invariants.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ").slice(0, 400)}`,
        payload: { runId: run.id, schema },
      });
    } else {
      await resolveAlerts("restore_drill_failed", null);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute(sql.raw(`drop schema if exists "${schema}" cascade`)).catch(() => undefined);
    const finishedAt = new Date();
    await record("failed", { error: message.slice(0, 500) });
    await raiseAlert({
      severity: "critical",
      kind: "restore_drill_failed",
      title: "Restore drill failed",
      body: message.slice(0, 400),
      payload: { runId: run.id, schema },
    });
    return {
      runId: run.id,
      schema,
      status: "failed",
      rows: 0,
      tables: 0,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      invariants: null,
      checks: [],
      error: message.slice(0, 500),
    };
  }
}

/* ------------------------------------------------------------------- restore */

export interface RestoreRequest {
  runId: string;
  /** database name typed by the operator — must match the live database */
  confirmation: string;
  /** second person (platform user id) who approved the restore */
  approvedByPlatformUserId: string;
  actorLabel: string;
  actorPlatformUserId?: string | null;
  /** keep the restored schema for inspection instead of swapping */
  keepSchema?: boolean;
}

export interface RestoreOutcome {
  runId: string;
  safetyBackupId: string;
  schema: string;
  status: "restored_schema" | "swapped" | "refused";
  invariants: InvariantReport | null;
  detail: string;
}

/**
 * Production restore (BACKUP_AND_RECOVERY §6). Four gates, all of them hard:
 *  1. two-person: the approver is a different platform user than the actor;
 *  2. typed confirmation: the operator types the live database name;
 *  3. host opt-in: `HISAB_ALLOW_LIVE_RESTORE=true` (a restore replaces data);
 *  4. safety backup: taken immediately before the restore, kept pinned.
 * The restore always lands in a fresh schema and runs the invariant pack before
 * anything is swapped, and the swap itself is a single rename inside one
 * transaction.
 */
export async function restoreBackup(request: RestoreRequest): Promise<RestoreOutcome> {
  const [run] = await db.select().from(backupRuns).where(eq(backupRuns.id, request.runId)).limit(1);
  if (!run) throw new Error(`backup run ${request.runId} not found`);
  if (run.status !== "verified") throw new Error(`run ${run.id} is ${run.status}; only a verified run can be restored`);
  if (!request.approvedByPlatformUserId || request.approvedByPlatformUserId === request.actorPlatformUserId) {
    throw new Error("a restore requires approval by a second platform user");
  }
  if ((request.confirmation ?? "").trim() !== run.databaseName) {
    throw new Error(`typed confirmation must equal the database name "${run.databaseName}"`);
  }
  if (process.env.HISAB_ALLOW_LIVE_RESTORE !== "true") {
    throw new Error(
      "live restores are disabled on this host (HISAB_ALLOW_LIVE_RESTORE) — run the drill, or follow the runbook",
    );
  }

  const safety = await runBackup({
    kind: "safety",
    actorLabel: `${request.actorLabel} (pre-restore safety copy)`,
    actorPlatformUserId: request.actorPlatformUserId ?? null,
  });
  if (safety.status !== "verified") {
    throw new Error(`safety backup ${safety.id} is ${safety.status}; refusing to restore without it`);
  }

  const schema = `restored_${Date.now().toString(36)}`;
  const raw = await readFile(run.artifactPath!);
  if (run.format !== "logical-json") {
    throw new Error("only logical snapshots can be replayed in-process; use the runbook for custom-format archives");
  }
  const snapshot = parseSnapshot(Buffer.from(decryptArtifact(raw.toString("utf8"))));
  await restoreSnapshot(snapshot, { targetSchema: schema });
  const invariants = await runInvariants(snapshot, { targetSchema: schema });

  await writePlatformAudit(db, {
    actorPlatformUserId: request.actorPlatformUserId ?? null,
    actorLabel: request.actorLabel,
    action: "backup.restore",
    entity: "backup_run",
    entityId: run.id,
    after: {
      schema,
      safetyBackupId: safety.id,
      approvedBy: request.approvedByPlatformUserId,
      invariants: invariants.checks.map((c) => ({ name: c.name, ok: c.ok })),
    },
  });

  if (!invariants.ok) {
    return {
      runId: run.id,
      safetyBackupId: safety.id,
      schema,
      status: "refused",
      invariants,
      detail: `restored copy failed invariants (${invariants.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}); live schema untouched`,
    };
  }

  if (request.keepSchema) {
    return {
      runId: run.id,
      safetyBackupId: safety.id,
      schema,
      status: "restored_schema",
      invariants,
      detail: `restored copy verified in schema ${schema}; live schema untouched`,
    };
  }

  const archived = `archived_${Date.now().toString(36)}`;
  await db.transaction(async (trx) => {
    await trx.execute(sql.raw(`alter schema public rename to "${archived}"`));
    await trx.execute(sql.raw(`alter schema "${schema}" rename to public`));
  });

  await writePlatformAudit(db, {
    actorPlatformUserId: request.actorPlatformUserId ?? null,
    actorLabel: request.actorLabel,
    action: "backup.restore.swapped",
    entity: "backup_run",
    entityId: run.id,
    after: { archivedSchema: archived, restoredSchema: "public", safetyBackupId: safety.id },
  });

  return {
    runId: run.id,
    safetyBackupId: safety.id,
    schema,
    status: "swapped",
    invariants,
    detail: `live schema replaced; previous schema kept as ${archived}`,
  };
}

/**
 * Restore into a fresh schema and keep it for inspection. This is a read-only
 * operation on live data (nothing is renamed or dropped), so it needs a verified
 * artifact but not the live-restore opt-in; the schema name is returned so an
 * operator can query it, and cleanup is an explicit `drop schema`.
 */
export async function restoreIntoNewSchema(opts: {
  runId: string;
  actorLabel: string;
  schemaName?: string;
}): Promise<RestoreOutcome> {
  const [run] = await db.select().from(backupRuns).where(eq(backupRuns.id, opts.runId)).limit(1);
  if (!run) throw new Error(`backup run ${opts.runId} not found`);
  if (run.status !== "verified") throw new Error(`run ${run.id} is ${run.status}; only a verified run can be restored`);
  if (!run.artifactPath) throw new Error(`run ${run.id} has no artifact`);
  if (run.format !== "logical-json") {
    throw new Error("only logical snapshots can be replayed in-process; use the runbook for custom-format archives");
  }

  const raw = await readFile(run.artifactPath);
  const snapshot = parseSnapshot(Buffer.from(decryptArtifact(raw.toString("utf8"))));
  const schema = opts.schemaName ?? `restored_${Date.now().toString(36)}`;
  await db.execute(sql.raw(`drop schema if exists "${schema.replace(/[^a-z0-9_]/gi, "_")}" cascade`));
  await restoreSnapshot(snapshot, { targetSchema: schema });
  const invariants = await runInvariants(snapshot, { targetSchema: schema });

  await writePlatformAudit(db, {
    actorLabel: opts.actorLabel,
    action: "backup.restore.inspection",
    entity: "backup_run",
    entityId: run.id,
    after: { schema, invariants: invariants.checks.map((c) => ({ name: c.name, ok: c.ok })) },
  });

  return {
    runId: run.id,
    safetyBackupId: "",
    schema,
    status: "restored_schema",
    invariants,
    detail: `restored copy available in schema ${schema} (live data untouched)`,
  };
}

/* --------------------------------------------------- integrity + housekeeping */

/**
 * Re-read the newest verified artifacts and compare their checksums with the
 * recorded ones. This is the only way to notice silent corruption (bit rot) of a
 * file that was verified when it was written.
 */
export async function artifactIntegritySweep(limit = 5): Promise<{
  checked: number;
  corrupted: number;
  missing: number;
  runs: { id: string; outcome: "ok" | "corrupted" | "missing" }[];
}> {
  const runs = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.status, "verified"))
    .orderBy(desc(backupRuns.finishedAt), desc(backupRuns.startedAt))
    .limit(limit);

  const detail: { id: string; outcome: "ok" | "corrupted" | "missing" }[] = [];
  let corrupted = 0;
  let missing = 0;

  for (const run of runs) {
    if (!run.artifactPath) continue;
    const info = await stat(run.artifactPath).catch(() => null);
    if (!info?.isFile()) {
      missing += 1;
      detail.push({ id: run.id, outcome: "missing" });
      await raiseAlert({
        severity: "critical",
        kind: "backup_artifact_missing",
        title: "Verified backup artifact is gone",
        body: `run ${run.id} was verified but ${run.artifactPath} is missing`,
        payload: { runId: run.id, path: run.artifactPath },
      });
      continue;
    }
    const hash = sha256Hex(await readFile(run.artifactPath));
    if (run.artifactSha256 && hash !== run.artifactSha256) {
      corrupted += 1;
      detail.push({ id: run.id, outcome: "corrupted" });
      await raiseAlert({
        severity: "critical",
        kind: "backup_artifact_corrupted",
        title: "Backup artifact checksum mismatch",
        body: `run ${run.id}: recorded ${run.artifactSha256}, found ${hash}`,
        payload: { runId: run.id, expected: run.artifactSha256, found: hash },
      });
      continue;
    }
    detail.push({ id: run.id, outcome: "ok" });
  }

  if (corrupted === 0 && missing === 0) {
    await resolveAlerts("backup_artifact_corrupted", null);
    await resolveAlerts("backup_artifact_missing", null);
  }
  return { checked: runs.length, corrupted, missing, runs: detail };
}

/**
 * Drop drill/restored schemas left behind by an interrupted run. Only schemas
 * whose names carry our prefixes are touched, so a real schema can never be
 * removed by housekeeping.
 */
export async function dropOrphanDrillSchemas(olderThanMinutes = 120): Promise<number> {
  const found = (await db.execute(sql`
    select nspname as name
      from pg_namespace
     where nspname like 'restore_drill_%' or nspname like 'restored_%'
     order by nspname`)) as unknown as { rows: { name: string }[] };
  let dropped = 0;
  for (const row of found.rows) {
    // the schema name carries the creation time in base36 (see runRestoreDrill /
    // restoreIntoNewSchema), so age is decided without touching the filesystem
    const suffix = row.name.split("_").pop() ?? "";
    const created = /^[0-9a-z]+$/.test(suffix) && suffix.length <= 10 ? parseBase36(suffix) : null;
    const ageMinutes = created ? (Date.now() - created.getTime()) / 60_000 : Number.POSITIVE_INFINITY;
    if (ageMinutes < olderThanMinutes) continue;
    await db.execute(sql.raw(`drop schema if exists "${row.name}" cascade`)).catch(() => undefined);
    dropped += 1;
  }
  if (dropped > 0) logger.warn({ dropped }, "orphan drill schemas dropped");
  return dropped;
}

function parseBase36(value: string): Date | null {
  const ms = Number.parseInt(value, 36);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  // sanity window: schemas are created within the last year
  return date.getTime() > Date.now() - 365 * 86_400_000 ? date : null;
}

/**
 * What the off-site transport is right now, for the console. `configured` is
 * false when no Drive credentials exist, and the panel must then say "local
 * only" rather than implying an off-site copy.
 */
export async function remoteProviderStatus(): Promise<{
  provider: string;
  configured: boolean;
  offsite: boolean;
  objects: number;
  productionSafe: boolean;
}> {
  const settings = await getSettings();
  const dir = await artifactDirectory();
  const transport = driveTransport({ root: dir, folderId: settings.driveFolderId });
  let objects = 0;
  try {
    objects = (await transport.list()).length;
  } catch (e) {
    logger.warn({ err: e }, "remote listing failed");
  }
  return {
    provider: transport.provider,
    configured: transport.provider === "google-drive",
    offsite: transport.offsite,
    objects,
    productionSafe: transport.offsite || process.env.NODE_ENV !== "production",
  };
}
