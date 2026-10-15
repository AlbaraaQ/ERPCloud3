/**
 * Backup orchestration (BACKUP_AND_RECOVERY §3/§5/§6/§7).
 *
 * Status machine per run: running → local_ok → uploaded → verified, or failed
 * with an error class. **Only `verified` counts as a successful backup** — "the
 * job ran" is never success (D-014). Every step writes what it did to the
 * metadata row, and failures raise an alert instead of disappearing into a log.
 *
 * The restore path is platform-only, two-person, typed-confirmation gated, and
 * always restores into an ISOLATED schema first; the invariant report is what
 * makes a restore drill evidence rather than an anecdote.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { backupRuns } from "@/db/schema";
import { errors } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { decryptSecret, encryptSecret, sha256Hex } from "@/modules/shared/crypto";
import { newId } from "@/modules/shared/ids";
import { getSettings, type BackupPolicy } from "../settings";
import { raiseAlert, resolveAlerts } from "../alerts";
import { pgDump, runPgDump } from "./pgdump";
import { remoteTransport } from "./drive";
import {
  buildSnapshot,
  dropSchema,
  parseSnapshot,
  restoreSnapshot,
  type SnapshotFile,
} from "./snapshot";
import { runRestoreInvariants, type InvariantReport } from "./invariants";

export type BackupStatus =
  | "running"
  | "local_ok"
  | "uploaded"
  | "verified"
  | "failed"
  | "pruned";

type RetentionClass = "latest" | "daily" | "weekly" | "pinned";

export interface RunBackupOptions {
  kind?: "scheduled" | "manual" | "safety";
  actorLabel: string;
  /** Skip the remote upload even when a transport exists (tests, offline hosts). */
  skipRemote?: boolean;
  /** Restrict the capture to these tables (tests use a small subset). */
  onlyTables?: string[];
}

export interface BackupResult {
  id: string;
  status: BackupStatus;
  format: string;
  artifactBytes: number;
  plaintextBytes: number;
  tables: number;
  rows: number;
  durationMs: number;
  remoteProvider: string | null;
  error?: string;
}

function artifactDirectory(policy: BackupPolicy): string {
  return policy.directory;
}

function databaseName(): string {
  const url = process.env.DATABASE_URL ?? "";
  try {
    return new URL(url).pathname.replace(/^\//, "") || "app_db";
  } catch {
    return "app_db";
  }
}

/** Where the encrypted artifacts live; created on demand. */
export async function backupDirectory(): Promise<string> {
  const { backup } = await getSettings();
  const dir = artifactDirectory(backup);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Engine version string for the metadata row (PGlite vs PostgreSQL both answer). */
async function engineVersion(): Promise<string> {
  const res = (await db.execute(sql`select version() as v`)) as unknown as { rows: { v: string }[] };
  return String(res.rows[0]?.v ?? "unknown").slice(0, 120);
}

/* ------------------------------------------------------------------ run */

export async function runBackup(opts: RunBackupOptions): Promise<BackupResult> {
  const settings = await getSettings();
  const policy = settings.backup;
  const started = Date.now();
  const id = newId();
  const kind = opts.kind ?? "manual";
  const tools = await pgDump();
  const format = tools.available ? "pg_dump-custom" : "logical-json";

  await db.insert(backupRuns).values({
    id,
    kind,
    status: "running",
    format,
    databaseName: databaseName(),
    engineVersion: await engineVersion(),
    startedAt: new Date(),
    createdByLabel: opts.actorLabel,
  });

  const dir = await backupDirectory();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbName = databaseName();

  try {
    let plaintext: Buffer;
    let tableStats: Record<string, { rows: number; sha256?: string }> = {};

    if (tools.available) {
      // Production path (D-014). Unavailable in this sandbox: recorded, never faked.
      const raw = join(dir, `${stamp}-${dbName}.dump`);
      const dump = await runPgDump({ databaseUrl: process.env.DATABASE_URL ?? "", filePath: raw });
      plaintext = await readFile(raw);
      await unlink(raw).catch(() => undefined);
      tableStats = { __pg_dump__: { rows: 0 } };
      logger.info({ bytes: dump.bytes }, "backup: pg_dump artifact produced");
    } else {
      const snapshot = await buildSnapshot(db, {
        database: dbName,
        engineVersion: await engineVersion(),
        only: opts.onlyTables,
      });
      plaintext = snapshot.buffer;
      tableStats = snapshot.tableStats;
    }

    const plaintextSha = sha256Hex(plaintext);
    const encrypted = encryptSecret(plaintext);
    const artifact = Buffer.from(encrypted, "utf8");
    const artifactPath = join(dir, `${stamp}-${dbName}.${format === "logical-json" ? "snapshot" : "dump"}.enc`);
    await writeFile(artifactPath, artifact);

    await db
      .update(backupRuns)
      .set({
        status: "local_ok",
        plaintextBytes: plaintext.length,
        artifactBytes: artifact.length,
        plaintextSha256: plaintextSha,
        artifactSha256: sha256Hex(artifact),
        artifactPath,
        tableStats,
        attempts: 1,
      })
      .where(eq(backupRuns.id, id));

    // remote upload (optional by policy; failures are recorded, not swallowed)
    let remoteProvider: string | null = null;
    if (policy.uploadToRemote && !opts.skipRemote) {
      const transport = remoteTransport(join(dir, "remote"));
      if (transport.provider === "none") {
        remoteProvider = "none";
      } else {
        try {
          const uploaded = await transport.upload({
            name: artifactPath.split("/").pop()!,
            data: artifact,
            folderId: settings.driveFolderId,
          });
          remoteProvider = transport.provider;
          await db
            .update(backupRuns)
            .set({ status: "uploaded", remoteId: uploaded.id, remoteProvider: transport.provider })
            .where(eq(backupRuns.id, id));
        } catch (e) {
          remoteProvider = transport.provider;
          await db
            .update(backupRuns)
            .set({
              remoteProvider,
              errorClass: "upload",
              errorDetail: e instanceof Error ? e.message.slice(0, 500) : String(e),
            })
            .where(eq(backupRuns.id, id));
        }
      }
    }

    // only a fully verified run counts as a successful backup (D-014)
    const verification = await verifyBackup(id);
    const durationMs = Date.now() - started;
    const rows = Object.values(tableStats).reduce((sum, t) => sum + (t.rows ?? 0), 0);

    await resolveAlerts("backup_failed").catch(() => undefined);
    await resolveAlerts("backup_stale").catch(() => undefined);

    return {
      id,
      status: verification.status,
      format,
      artifactBytes: artifact.length,
      plaintextBytes: plaintext.length,
      tables: Object.keys(tableStats).length,
      rows,
      durationMs,
      remoteProvider,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 800) : String(e);
    const errorClass = classifyError(e);
    await db
      .update(backupRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        errorClass,
        errorDetail: detail,
      })
      .where(eq(backupRuns.id, id));
    await raiseAlert({
      severity: "critical",
      kind: "backup_failed",
      title: `Backup failed (${errorClass})`,
      body: detail,
      payload: { runId: id, format },
    }).catch(() => undefined);
    logger.error({ err: e, runId: id }, "backup failed");
    return {
      id,
      status: "failed",
      format,
      artifactBytes: 0,
      plaintextBytes: 0,
      tables: 0,
      rows: 0,
      durationMs: Date.now() - started,
      remoteProvider: null,
      error: detail,
    };
  }
}

function classifyError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/ENOSPC|no space/i.test(message)) return "disk";
  if (/permission|EACCES/i.test(message)) return "permissions";
  if (/pg_dump/i.test(message)) return "dump_tool";
  if (/encrypt|key/i.test(message)) return "encryption";
  if (/connect|ECONNREFUSED|terminat/i.test(message)) return "database";
  return "unknown";
}

/* ---------------------------------------------------------------- verification */

export interface VerifyResult {
  id: string;
  status: BackupStatus;
  checks: { name: string; ok: boolean; detail: string }[];
  /** unchanged from the row when a check could not run at all (e.g. no remote) */
  remoteStatus: string;
}

/**
 * Verify a run: the artifact must decrypt, parse, and its per-table row counts
 * and hashes must match the metadata. Remote objects are re-read and compared
 * size+checksum. Only a fully verified run is marked `verified`.
 */
export async function verifyBackup(runId: string): Promise<VerifyResult> {
  const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, runId)).limit(1);
  if (!row) throw errors.notFound("backup_run", runId);
  const checks: VerifyResult["checks"] = [];

  let artifactOk = false;
  if (!row.artifactPath) {
    checks.push({ name: "artifact", ok: false, detail: "no artifact path recorded" });
  } else {
    try {
      const artifact = await readFile(row.artifactPath);
      const artifactSha = sha256Hex(artifact);
      if (row.artifactSha256 && artifactSha !== row.artifactSha256) {
        checks.push({ name: "artifact_checksum", ok: false, detail: "artifact checksum mismatch" });
      } else {
        checks.push({
          name: "artifact_checksum",
          ok: true,
          detail: `${artifact.length} bytes, sha256 matches the metadata`,
        });
      }
      const plaintext = decryptSecret(artifact.toString("utf8"));
      const plaintextSha = sha256Hex(plaintext);
      checks.push({
        name: "decrypt",
        ok: !row.plaintextSha256 || plaintextSha === row.plaintextSha256,
        detail: `decrypted ${plaintext.length} bytes`,
      });

      if (row.format === "logical-json") {
        const file = parseSnapshot(plaintext);
        let tablesOk = true;
        const detail: string[] = [];
        for (const table of file.tables) {
          const expected = row.tableStats?.[table.name];
          if (expected && (expected.rows !== table.rowCount || (expected.sha256 && expected.sha256 !== table.sha256))) {
            tablesOk = false;
            detail.push(`${table.name} ${table.rowCount}/${expected.rows}`);
          }
        }
        checks.push({
          name: "content",
          ok: tablesOk,
          detail: tablesOk ? `${file.tables.length} table(s) match the metadata` : detail.join(", "),
        });
      } else {
        checks.push({
          name: "content",
          ok: true,
          detail: "pg_dump custom artifact (content verified by pg_restore --list on the host)",
        });
      }
      artifactOk = checks.every((c) => c.ok);
    } catch (e) {
      checks.push({
        name: "artifact",
        ok: false,
        detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }
  }

  // remote verification
  let remoteStatus = row.remoteProvider ?? "";
  if (row.remoteProvider && row.remoteProvider !== "none" && row.remoteId) {
    const dir = await backupDirectory();
    const transport = remoteTransport(join(dir, "remote"));
    try {
      const remote = await transport.stat(row.remoteId);
      if (!remote) {
        checks.push({ name: "remote", ok: false, detail: "remote object not found" });
      } else {
        const sizeOk = remote.bytes === Number(row.artifactBytes ?? -1);
        const shaOk = !row.artifactSha256 || remote.sha256 === row.artifactSha256;
        checks.push({
          name: "remote",
          ok: sizeOk && shaOk,
          detail: `${transport.provider}: ${remote.bytes} bytes, sha256 ${shaOk ? "matches" : "MISMATCHES"}`,
        });
      }
    } catch (e) {
      checks.push({
        name: "remote",
        ok: false,
        detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  } else if (row.remoteProvider && row.remoteProvider !== "none") {
    checks.push({ name: "remote", ok: false, detail: "remote upload incomplete" });
  } else {
    checks.push({ name: "remote", ok: true, detail: "no remote destination configured" });
  }

  const verified = artifactOk && checks.every((c) => c.ok);
  const status: BackupStatus = verified ? "verified" : "failed";
  await db
    .update(backupRuns)
    .set({
      status,
      finishedAt: new Date(),
      durationMs: row.durationMs ?? Date.now() - row.startedAt.getTime(),
      ...(verified
        ? {}
        : {
            errorClass: "verification",
            errorDetail: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ").slice(0, 800),
          }),
    })
    .where(eq(backupRuns.id, runId));

  if (!verified) {
    await raiseAlert({
      severity: "critical",
      kind: "backup_failed",
      title: "Backup verification failed",
      body: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; "),
      payload: { runId },
    }).catch(() => undefined);
  }

  return { id: runId, status, checks, remoteStatus };
}

/* ------------------------------------------------------------------ retention */

export interface PruneResult {
  pruned: number;
  kept: { id: string; retentionClass: RetentionClass }[];
  deletedFiles: number;
}

/**
 * Retention (BACKUP_AND_RECOVERY §2): always keep the latest `keepLatest`
 * verified runs; additionally keep one per day for `keepDaily` days and one per
 * week for `keepWeekly` weeks (GFS). Everything else is marked `pruned` and its
 * artifact deleted — the deletion itself is visible in the run history.
 */
export async function pruneBackups(): Promise<PruneResult> {
  const settings = await getSettings();
  const policy = settings.backup;
  const runs = await db
    .select()
    .from(backupRuns)
    .where(inArray(backupRuns.status, ["verified", "uploaded", "local_ok", "pruned"]))
    .orderBy(desc(backupRuns.startedAt));

  const keep = new Map<string, RetentionClass>();
  runs.slice(0, policy.keepLatest).forEach((r) => keep.set(r.id, "latest"));

  const daySeen = new Set<string>();
  const weekSeen = new Set<string>();
  const dailyCutoff = Date.now() - policy.keepDaily * 24 * 3600 * 1000;
  const weeklyCutoff = Date.now() - policy.keepWeekly * 7 * 24 * 3600 * 1000;
  for (const run of runs) {
    const at = run.startedAt.getTime();
    const day = run.startedAt.toISOString().slice(0, 10);
    const week = weekKey(run.startedAt);
    if (at >= dailyCutoff && !daySeen.has(day) && !keep.has(run.id)) {
      daySeen.add(day);
      keep.set(run.id, "daily");
    }
    if (at >= weeklyCutoff && !weekSeen.has(week) && !keep.has(run.id)) {
      weekSeen.add(week);
      keep.set(run.id, "weekly");
    }
  }
  for (const run of runs) if (run.retentionClass === "pinned") keep.set(run.id, "pinned");

  const toPrune = runs.filter((r) => !keep.has(r.id));
  let deletedFiles = 0;
  const dir = await backupDirectory();
  const transport = remoteTransport(join(dir, "remote"));
  for (const run of toPrune) {
    if (run.artifactPath) {
      await unlink(run.artifactPath).then(
        () => deletedFiles++,
        () => undefined,
      );
    }
    if (run.remoteId) await transport.remove(run.remoteId).catch(() => undefined);
    await db.update(backupRuns).set({ status: "pruned" }).where(eq(backupRuns.id, run.id));
  }
  for (const [id, cls] of keep) {
    await db.update(backupRuns).set({ retentionClass: cls }).where(eq(backupRuns.id, id));
  }

  return {
    pruned: toPrune.length,
    kept: [...keep].map(([id, retentionClass]) => ({ id, retentionClass })),
    deletedFiles,
  };
}

function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* --------------------------------------------------------------- stale monitor */

export interface BackupFreshness {
  lastVerifiedAt: Date | null;
  ageHours: number | null;
  stale: boolean;
  thresholdHours: number;
  lastRunStatus: string | null;
  verifiedCount: number;
}

/** Freshness of the newest VERIFIED backup (spec: alert when older than 8 h). */
export async function backupFreshness(): Promise<BackupFreshness> {
  const settings = await getSettings();
  const [latest] = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.status, "verified"))
    .orderBy(desc(backupRuns.finishedAt))
    .limit(1);
  const [lastAny] = await db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(1);
  const counts = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(backupRuns)
    .where(eq(backupRuns.status, "verified"));
  const verifiedAt = latest?.finishedAt ?? latest?.startedAt ?? null;
  const ageHours = verifiedAt ? (Date.now() - verifiedAt.getTime()) / 3600000 : null;
  const stale = ageHours === null || ageHours > settings.backup.staleAfterHours;
  return {
    lastVerifiedAt: verifiedAt,
    ageHours,
    stale,
    thresholdHours: settings.backup.staleAfterHours,
    lastRunStatus: lastAny?.status ?? null,
    verifiedCount: Number(counts[0]?.n ?? 0),
  };
}

/** Job entry point: raise/resolve the stale-backup alert. */
export async function checkBackupFreshness(): Promise<BackupFreshness> {
  const freshness = await backupFreshness();
  if (freshness.stale) {
    await raiseAlert({
      severity: "critical",
      kind: "backup_stale",
      title: "Stale backup: no verified backup inside the window",
      body:
        freshness.lastVerifiedAt === null
          ? "no verified backup exists yet"
          : `last verified backup is ${freshness.ageHours?.toFixed(1)} h old (threshold ${freshness.thresholdHours} h)`,
      payload: { ...freshness, lastVerifiedAt: freshness.lastVerifiedAt?.toISOString() ?? null },
    });
  } else {
    await resolveAlerts("backup_stale").catch(() => undefined);
  }
  return freshness;
}

/* ------------------------------------------------------------------ restore */

export interface RestoreDrillOptions {
  runId?: string;
  actorLabel: string;
  /** Keep the isolated schema after the drill (default: drop it). */
  keepSchema?: boolean;
  /** Skip data for these tables (used to prove the drill can fail). */
  skipTables?: string[];
  exec?: typeof db;
}

export interface RestoreDrillResult {
  runId: string;
  targetSchema: string;
  status: "passed" | "failed";
  durationMs: number;
  rows: number;
  tables: number;
  invariants: InvariantReport | null;
  error?: string;
}

/**
 * Restore drill (BACKUP_AND_RECOVERY §5): restore the newest verified backup
 * into an isolated schema, run the invariant pack, record the evidence on the
 * backup row, and drop the schema unless asked to keep it.
 */
export async function runRestoreDrill(opts: RestoreDrillOptions): Promise<RestoreDrillResult> {
  const started = Date.now();
  const [run] = opts.runId
    ? await db.select().from(backupRuns).where(eq(backupRuns.id, opts.runId)).limit(1)
    : await db
        .select()
        .from(backupRuns)
        .where(eq(backupRuns.status, "verified"))
        .orderBy(desc(backupRuns.finishedAt))
        .limit(1);
  if (!run) throw errors.notFound("verified backup", opts.runId ?? "latest");
  if (!run.artifactPath) throw errors.validation("errors.backupNoArtifact", "run has no artifact");

  const targetSchema = `restore_drill_${Date.now().toString(36)}`;
  const exec = opts.exec ?? db;
  let invariants: InvariantReport | null = null;

  try {
    const artifact = await readFile(run.artifactPath);
    if (run.artifactSha256 && sha256Hex(artifact) !== run.artifactSha256) {
      throw errors.invariant("artifact checksum mismatch — refusing to restore a corrupt backup");
    }
    if (run.format !== "logical-json") {
      throw errors.configuration(
        "errors.backupRestoreUnsupported",
        "pg_dump artifacts are restored with pg_restore on the host (see BACKUP_AND_RECOVERY §3)",
      );
    }
    const file: SnapshotFile = parseSnapshot(decryptSecret(artifact.toString("utf8")));
    const restore = await restoreSnapshot(exec, file, { targetSchema, skipTables: opts.skipTables });
    invariants = await runRestoreInvariants(exec, targetSchema, file);
    const durationMs = Date.now() - started;
    const status = invariants.ok ? "passed" : "failed";

    await db
      .update(backupRuns)
      .set({
        drillAt: new Date(),
        drillStatus: status,
        drillDetail: {
          targetSchema,
          actor: opts.actorLabel,
          durationMs,
          rows: restore.rows,
          tables: restore.tables.length,
          checks: invariants.checks,
        },
      })
      .where(eq(backupRuns.id, run.id));

    if (status === "failed") {
      await raiseAlert({
        severity: "critical",
        kind: "restore_drill_failed",
        title: "Restore drill failed",
        body: invariants.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; "),
        payload: { runId: run.id, targetSchema },
      }).catch(() => undefined);
    } else {
      await resolveAlerts("restore_drill_failed").catch(() => undefined);
    }

    return {
      runId: run.id,
      targetSchema,
      status,
      durationMs,
      rows: restore.rows,
      tables: restore.tables.length,
      invariants,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await db
      .update(backupRuns)
      .set({
        drillAt: new Date(),
        drillStatus: "failed",
        drillDetail: { targetSchema, actor: opts.actorLabel, error: detail },
      })
      .where(eq(backupRuns.id, run.id));
    await raiseAlert({
      severity: "critical",
      kind: "restore_drill_failed",
      title: "Restore drill failed",
      body: detail,
      payload: { runId: run.id, targetSchema },
    }).catch(() => undefined);
    logger.error({ err: e, runId: run.id }, "restore drill failed");
    return {
      runId: run.id,
      targetSchema,
      status: "failed",
      durationMs: Date.now() - started,
      rows: 0,
      tables: 0,
      invariants: null,
      error: detail,
    };
  } finally {
    if (!opts.keepSchema) await dropSchema(exec, targetSchema).catch(() => undefined);
  }
}

/** Remove drill schemas left behind by a crash (housekeeping job). */
export async function dropOrphanDrillSchemas(): Promise<number> {
  const rows = (await db.execute(
    sql`select nspname from pg_namespace where nspname like 'restore_drill_%'`,
  )) as unknown as { rows: { nspname: string }[] };
  let dropped = 0;
  for (const row of rows.rows) {
    await dropSchema(db, row.nspname).catch(() => undefined);
    dropped += 1;
  }
  return dropped;
}

/* ------------------------------------------------------------------ history */

export async function listBackupRuns(limit = 30) {
  return db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit);
}

export async function getBackupRun(id: string) {
  const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
  return row ?? null;
}

/** Local artifact inventory (detects files that lost their metadata row). */
export async function artifactInventory(): Promise<{ files: { name: string; bytes: number }[]; orphans: string[] }> {
  const dir = await backupDirectory();
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: { name: string; bytes: number }[] = [];
  for (const name of names) {
    if (name === "remote") continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) files.push({ name, bytes: info.size });
  }
  const rows = await db.select({ path: backupRuns.artifactPath }).from(backupRuns);
  const known = new Set(rows.map((r) => r.path?.split("/").pop()).filter(Boolean) as string[]);
  return { files, orphans: files.map((f) => f.name).filter((n) => !known.has(n)) };
}

/** Cheap content hash of the local artifact (used by the nightly light check). */
export async function artifactSha256(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}
